"""A pack's optional per-state sound cues.

A pack is third-party content, possibly hand-edited, so the rule these tests hold
is the one the rest of the store already lives by: **a bad entry costs that entry,
never the pack.** A cue naming a traversal, a cue too big to play, a "cue" that is
really a PNG -- each is dropped with a warning and the pack's art still loads.

The second property is that presence and content cannot disagree. The detail
payload reports which states HAVE a cue so the client never has to probe, and the
byte route serves them; both read one function, so a state the payload advertises
is a state the route can answer.

The third is that a bundle is the WHOLE pack. Art and cues travel together, so
export -> delete -> import returns the pack the user had rather than a silent one
-- and audio is judged at the import boundary, where the person who picked the
file can see why it was refused.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from kiro_crew.appearance_packs import sounds as snd
from kiro_crew.appearance_packs import store as st
from kiro_crew.appearance_packs import transfer as transfer_mod
from kiro_crew.appearance_packs.transfer import export_bundle, import_bundle, save_sprite_pack

#: A structurally recognisable WAV: the sniffer reads the RIFF/WAVE header, and
#: nothing here needs it to be playable.
_WAV = b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00"
_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00frames"
_OGG = b"OggS\x00\x02\x00\x00\x00\x00\x00\x00"
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _store(tmp_path) -> st.AppearanceStore:
    store = st.AppearanceStore(tmp_path)
    store.load()
    return store


def _write_pack(tmp_path, ident="cue-pack", *, sounds=None, files=None):
    """A minimal pack on disk: one idle frame plus whatever cues are asked for."""
    pack = tmp_path / st.PACKS_DIRNAME / ident
    pack.mkdir(parents=True)
    manifest: dict = {
        "meta": {"id": ident, "name": "Cue", "format": "svg"},
        "states": {"idle": "idle.svg"},
    }
    if sounds is not None:
        manifest["sounds"] = sounds
    (pack / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    (pack / "idle.svg").write_text("<svg/>", "utf-8")
    for name, content in (files or {}).items():
        (pack / name).write_text(content, "utf-8")
    return pack


class TestReadingSounds:
    def test_a_valid_cue_is_served_with_its_sniffed_type(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "done.wav"}, files={"done.wav": _b64(_WAV)})
        store = _store(tmp_path)
        assert store.pack_sound("cue-pack", "done") == (_WAV, "audio/wav")

    @pytest.mark.parametrize(
        ("name", "raw", "mime"),
        [("a.mp3", _MP3, "audio/mpeg"), ("a.ogg", _OGG, "audio/ogg")],
    )
    def test_every_accepted_container_is_recognised(self, tmp_path, name, raw, mime):
        _write_pack(tmp_path, sounds={"working": name}, files={name: _b64(raw)})
        store = _store(tmp_path)
        assert store.pack_sound("cue-pack", "working") == (raw, mime)

    def test_the_type_comes_from_the_bytes_not_the_filename(self, tmp_path):
        """A manifest is hand-editable, so a name is not evidence.

        Serving a PNG as ``audio/mpeg`` because the file was called ``.mp3`` would
        hand the browser a content type its bytes contradict, on content a third
        party authored.
        """
        _write_pack(tmp_path, sounds={"done": "done.mp3"}, files={"done.mp3": _b64(_PNG)})
        store = _store(tmp_path)
        assert store.pack_sound("cue-pack", "done") is None
        assert store.pack_sounds("cue-pack") == {}

    def test_an_oversize_cue_is_dropped_not_truncated(self, tmp_path):
        big = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (snd.MAX_SOUND_BYTES + 1)
        _write_pack(tmp_path, sounds={"error": "e.wav"}, files={"e.wav": _b64(big)})
        store = _store(tmp_path)
        assert store.pack_sounds("cue-pack") == {}
        assert store.pack_sound("cue-pack", "error") is None

    def test_a_cue_exactly_at_the_ceiling_is_kept(self, tmp_path):
        raw = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (snd.MAX_SOUND_BYTES - 12)
        assert len(raw) == snd.MAX_SOUND_BYTES
        _write_pack(tmp_path, sounds={"error": "e.wav"}, files={"e.wav": _b64(raw)})
        store = _store(tmp_path)
        assert store.pack_sound("cue-pack", "error") == (raw, "audio/wav")

    @pytest.mark.parametrize(
        "filename",
        ["../../escape.wav", "sub/dir.wav", ".hidden.wav", "cue.exe", "cue.svg", 7, None],
    )
    def test_an_unusable_filename_is_dropped(self, tmp_path, filename):
        _write_pack(tmp_path, sounds={"done": filename}, files={"cue.svg": _b64(_WAV)})
        store = _store(tmp_path)
        assert store.pack_sounds("cue-pack") == {}

    def test_a_named_but_absent_file_is_dropped(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "missing.wav"})
        assert _store(tmp_path).pack_sounds("cue-pack") == {}

    def test_content_that_is_not_base64_is_dropped(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": "not base64 !!"})
        assert _store(tmp_path).pack_sounds("cue-pack") == {}

    def test_one_bad_cue_does_not_cost_the_good_one(self, tmp_path):
        _write_pack(
            tmp_path,
            sounds={"done": "d.wav", "error": "../evil.wav"},
            files={"d.wav": _b64(_WAV)},
        )
        assert _store(tmp_path).pack_sounds("cue-pack") == {"done": True}

    def test_a_pack_with_no_sounds_section_reads_as_none(self, tmp_path):
        _write_pack(tmp_path)
        assert _store(tmp_path).pack_sounds("cue-pack") == {}

    @pytest.mark.parametrize("junk", ["cue.wav", ["cue.wav"], 7])
    def test_a_junk_sounds_section_is_not_fatal(self, tmp_path, junk):
        pack = tmp_path / st.PACKS_DIRNAME / "cue-pack"
        pack.mkdir(parents=True)
        (pack / "manifest.json").write_text(
            json.dumps(
                {
                    "meta": {"id": "cue-pack", "name": "Cue"},
                    "states": {"idle": "idle.svg"},
                    "sounds": junk,
                }
            ),
            "utf-8",
        )
        (pack / "idle.svg").write_text("<svg/>", "utf-8")
        store = _store(tmp_path)
        assert store.pack_sounds("cue-pack") == {}
        # The point of "not fatal": the art still loads.
        assert "idle" in (store.pack_detail("cue-pack") or {}).get("animations", {})

    def test_a_state_outside_the_vocabulary_is_ignored(self, tmp_path):
        """Only the three agent lifecycle states are addressable.

        An unknown key cannot grow the set a client has to probe, and there is no
        renderer state for it to fire on.
        """
        _write_pack(tmp_path, sounds={"sleepy": "s.wav"}, files={"s.wav": _b64(_WAV)})
        assert _store(tmp_path).pack_sounds("cue-pack") == {}

    def test_idle_is_not_a_cue_state(self, tmp_path):
        """A cue fires on a transition; ``idle`` is the state the art rests in.

        A cue accepted on it would play whenever a crew went back to resting,
        which for a busy roster is a sound with no event behind it.
        """
        assert "idle" not in snd.SOUND_STATES
        _write_pack(tmp_path, sounds={"idle": "i.wav"}, files={"i.wav": _b64(_WAV)})
        assert _store(tmp_path).pack_sounds("cue-pack") == {}

    def test_the_builtin_has_no_sounds(self, tmp_path):
        """It ships inside the frontend bundle, so it has no pack directory."""
        store = _store(tmp_path)
        assert store.pack_sounds(st.DEFAULT_PACK) == {}
        assert store.pack_sound(st.DEFAULT_PACK, "done") is None

    @pytest.mark.parametrize("state", [None, 7, ["done"], "", "nope"])
    def test_a_junk_state_is_answered_with_nothing(self, tmp_path, state):
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        assert _store(tmp_path).pack_sound("cue-pack", state) is None

    def test_a_linked_cue_file_is_refused_like_any_other_pack_file(self, tmp_path):
        """The cue read goes through the ordinary pack-file read, not around it.

        That read refuses a link BEFORE resolving it, so a cue pointed at a file
        elsewhere on disk cannot have its bytes served to the dashboard.

        The contract here is the symlink mechanism itself, so the test is listed in
        ``test/requires-real-symlinks.txt`` and the root conftest applies the skip
        from its own capability probe. A local try/except would be a second copy of
        that policy, and would drop the assertion on the privileged hosts where the
        repo's machinery keeps it.
        """
        pack = _write_pack(tmp_path, sounds={"done": "d.wav"})
        secret = tmp_path / "secret.txt"
        secret.write_text(_b64(_WAV), "utf-8")
        (pack / "d.wav").symlink_to(secret)
        assert _store(tmp_path).pack_sounds("cue-pack") == {}


class TestDetailAdvertisesSounds:
    def test_detail_reports_presence_so_the_client_need_not_probe(self, tmp_path):
        _write_pack(
            tmp_path,
            sounds={"done": "d.wav", "working": "w.mp3"},
            files={"d.wav": _b64(_WAV), "w.mp3": _b64(_MP3)},
        )
        detail = _store(tmp_path).pack_detail("cue-pack")
        assert detail is not None
        assert detail["sounds"] == {"working": True, "done": True}

    def test_detail_does_not_inline_the_audio(self, tmp_path):
        """The roster fetches this payload to draw a face.

        Inlining hundreds of KB of base64 audio into it would make every roster
        render pay for cues it may never play.
        """
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        detail = _store(tmp_path).pack_detail("cue-pack")
        assert detail is not None
        assert _b64(_WAV) not in json.dumps(detail)

    def test_a_pack_without_cues_still_carries_the_key(self, tmp_path):
        _write_pack(tmp_path)
        detail = _store(tmp_path).pack_detail("cue-pack")
        assert detail is not None
        assert detail["sounds"] == {}

    def test_the_builtin_carries_the_key_too(self, tmp_path):
        detail = _store(tmp_path).pack_detail(st.DEFAULT_PACK)
        assert detail is not None
        assert detail["sounds"] == {}


class TestBundlesCarrySounds:
    """A bundle is the whole pack: art plus cues.

    Export reads the store's own shape rather than the detail payload (which
    reports cues as presence only), so a bundle carries bytes for every cue it
    names -- otherwise export -> delete -> import would return a silent pack, the
    same way it once returned one with no sprite sheet. Import judges the audio at
    the boundary instead of leaving it to the reader's drop-with-a-warning, so a
    file that will never play is refused where the user can see why.
    """

    def test_a_round_trip_returns_the_cue(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        bundle = export_bundle(_store(tmp_path), "cue-pack")
        assert bundle is not None
        assert bundle["manifest"]["sounds"] == {"done": "d.wav"}
        assert bundle["files"]["d.wav"] == _b64(_WAV)

        fresh = tmp_path / "elsewhere"
        target = _store(fresh)
        assert import_bundle(target, bundle) == {"ok": True, "id": "cue-pack"}
        assert target.pack_sound("cue-pack", "done") == (_WAV, "audio/wav")

    def test_an_export_with_no_cues_names_no_sounds_section(self, tmp_path):
        _write_pack(tmp_path)
        bundle = export_bundle(_store(tmp_path), "cue-pack")
        assert bundle is not None
        assert "sounds" not in bundle["manifest"]

    def test_a_cue_named_by_a_manifest_with_no_file_is_dropped_from_the_export(self, tmp_path):
        """An absent file is junk the read path drops, so the export proceeds.

        Refusing here would be a permanent lockout rather than a guard: nothing
        the user can do from the gallery would ever make that pack exportable
        again. The transient case -- the file is there and the read fails -- is
        what the refusal is for, pinned separately.
        """
        _write_pack(tmp_path, sounds={"done": "gone.wav"})
        bundle = export_bundle(_store(tmp_path), "cue-pack")
        assert bundle is not None
        assert "sounds" not in bundle["manifest"]
        assert "gone.wav" not in bundle["files"]

    def test_an_unreadable_cue_file_also_refuses_the_export(self, tmp_path):
        """The file exists and the read fails -- a lock, an IO error."""
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        store = _store(tmp_path)
        assert export_bundle(store, "cue-pack") is not None
        real_read = st.AppearanceStore._read_pack_file

        def _cue_unreadable(self, pack_dir, filename):
            if str(filename).endswith(".wav"):
                return None
            return real_read(self, pack_dir, filename)

        with pytest.MonkeyPatch.context() as patched:
            patched.setattr(st.AppearanceStore, "_read_pack_file", _cue_unreadable)
            assert export_bundle(store, "cue-pack") is None

    def test_a_pack_whose_cues_all_read_still_exports(self, tmp_path):
        """The guard must not refuse the ordinary case it is protecting."""
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        bundle = export_bundle(_store(tmp_path), "cue-pack")
        assert bundle is not None
        assert bundle["manifest"]["sounds"] == {"done": "d.wav"}

    @pytest.mark.parametrize("suffix", snd.SOUND_SUFFIXES)
    def test_every_accepted_suffix_imports(self, tmp_path, suffix):
        raw = {".wav": _WAV, ".mp3": _MP3, ".ogg": _OGG}[suffix]
        bundle = {
            "kind": "crew-companion-pack",
            "version": 1,
            "id": "noisy",
            "manifest": {
                "meta": {"id": "noisy"},
                "states": {"idle": "idle.svg"},
                "sounds": {"done": f"done{suffix}"},
            },
            "files": {"idle.svg": "<svg/>", f"done{suffix}": _b64(raw)},
        }
        store = _store(tmp_path)
        assert import_bundle(store, bundle)["ok"] is True
        assert store.pack_sounds("noisy") == {"done": True}

    def test_a_sound_only_bundle_is_refused(self, tmp_path):
        """A pack with nothing to draw is not a face.

        Widening the allowlist to audio made a sound-only bundle pass the
        "has any file" check, and such a pack installs as a blank the user cannot
        explain -- so the art requirement is counted on ART, not on files.
        """
        bundle = {
            "kind": "crew-companion-pack",
            "version": 1,
            "id": "voice-only",
            "manifest": {"meta": {"id": "voice-only"}, "sounds": {"done": "d.wav"}},
            "files": {"d.wav": _b64(_WAV)},
        }
        store = _store(tmp_path)
        result = import_bundle(store, bundle)
        assert result["ok"] is False
        assert result["error"] == "That bundle has no art in it"
        assert not store.pack_exists("voice-only")

    @pytest.mark.parametrize(
        ("content", "fragment"),
        [
            ("not base64 !!", "not base64-encoded audio"),
            (_b64(_PNG), "not an mp3, ogg or wav"),
            ("", "is empty"),
        ],
    )
    def test_audio_that_would_never_play_is_refused_at_the_boundary(
        self, tmp_path, content, fragment
    ):
        bundle = {
            "kind": "crew-companion-pack",
            "version": 1,
            "id": "noisy",
            "manifest": {"meta": {"id": "noisy"}, "states": {"idle": "idle.svg"}},
            "files": {"idle.svg": "<svg/>", "done.wav": content},
        }
        store = _store(tmp_path)
        result = import_bundle(store, bundle)
        assert result["ok"] is False
        assert fragment in result["error"]
        assert not store.pack_exists("noisy")

    def test_an_oversize_cue_is_refused_by_its_own_cap(self, tmp_path):
        """The audio cap is far below the per-file art cap, and names itself.

        "Too long a sound" and "not a sound at all" are different mistakes with
        different fixes, and this string is what the import dialog shows.
        """
        big = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (snd.MAX_SOUND_BYTES + 1)
        assert len(big) < st.MAX_FILE_BYTES, "the art cap must not be what refuses this"
        bundle = {
            "kind": "crew-companion-pack",
            "version": 1,
            "id": "noisy",
            "manifest": {"meta": {"id": "noisy"}, "states": {"idle": "idle.svg"}},
            "files": {"idle.svg": "<svg/>", "done.wav": _b64(big)},
        }
        result = import_bundle(_store(tmp_path), bundle)
        assert result["ok"] is False
        assert "longer sound than a pack may carry" in result["error"]

    @staticmethod
    def _bundle(sounds, files):
        return {
            "kind": "crew-companion-pack",
            "version": 1,
            "id": "noisy",
            "manifest": {
                "meta": {"id": "noisy"},
                "states": {"idle": "idle.svg"},
                **({} if sounds is None else {"sounds": sounds}),
            },
            "files": {"idle.svg": "<svg/>", **files},
        }

    def test_a_named_cue_with_no_carried_file_is_refused(self, tmp_path):
        """The mirror of the art reference check, and for the same reason.

        The carried-file loop judges what a bundle SHIPS, never what its manifest
        POINTS AT, so this bundle installed happily and then answered 404 on the
        cue -- a 200 that said it worked.
        """
        store = _store(tmp_path)
        result = import_bundle(store, self._bundle({"done": "done.wav"}, {}))
        assert result["ok"] is False
        assert "does not carry it" in result["error"]
        assert not store.pack_exists("noisy")

    @pytest.mark.parametrize(
        "filename",
        ["../escape.wav", "sub/dir.wav", ".hidden.wav", "cue.exe", "cue.svg", 7, True],
    )
    def test_a_named_cue_that_is_not_a_usable_filename_is_refused(self, tmp_path, filename):
        store = _store(tmp_path)
        result = import_bundle(store, self._bundle({"done": filename}, {}))
        assert result["ok"] is False
        assert "not a usable sound filename" in result["error"]

    def test_a_junk_sounds_section_is_refused_at_the_boundary(self, tmp_path):
        """Dropped with a warning by the READER, refused by the IMPORTER.

        The reader tolerates a hand-edited pack already on disk; the importer is
        the boundary where a person can still be told the bundle is wrong.
        """
        store = _store(tmp_path)
        result = import_bundle(store, self._bundle("done.wav", {}))
        assert result["ok"] is False
        assert "not a map of states to files" in result["error"]

    def test_a_state_outside_the_vocabulary_is_ignored_not_refused(self, tmp_path):
        """The reader ignores it, so the importer must not refuse the whole bundle."""
        store = _store(tmp_path)
        assert import_bundle(store, self._bundle({"sleepy": "s.wav"}, {}))["ok"] is True
        assert store.pack_sounds("noisy") == {}

    def test_a_bundle_whose_references_all_resolve_still_imports(self, tmp_path):
        store = _store(tmp_path)
        bundle = self._bundle({"done": "done.wav"}, {"done.wav": _b64(_WAV)})
        assert import_bundle(store, bundle)["ok"] is True
        assert store.pack_sounds("noisy") == {"done": True}

    def test_a_sprite_filename_still_refuses_an_audio_suffix(self, tmp_path):
        """The art allowlist stayed narrow: only the bundle importer widened."""
        result = save_sprite_pack(
            _store(tmp_path),
            "spr",
            {"meta": {"id": "spr"}, "states": {"idle": "sprites.png"}},
            _b64(_PNG),
            filename="sheet.wav",
        )
        assert result["ok"] is False


class TestEditingAPackKeepsItsSounds:
    """An overwrite that names no sounds keeps the ones already on disk.

    The gallery editor reads ``pack_detail`` (presence-only for sounds) and saves
    the whole pack back, so its save carries no cue files and no ``sounds`` map --
    and re-saving a pack would silently delete its cues. Absent key = leave alone;
    an explicit map is the only way to remove one.
    """

    def _seeded(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        return _store(tmp_path)

    def test_an_editor_style_resave_keeps_the_cue(self, tmp_path):
        store = self._seeded(tmp_path)
        # Exactly what the editor sends: meta + states + art, nothing about sounds.
        ok = store.save_pack(
            "cue-pack",
            {"meta": {"id": "cue-pack", "name": "Renamed"}, "states": {"idle": "idle.svg"}},
            {"idle.svg": "<svg id='v2'/>"},
        )
        assert ok is True
        assert store.pack_sound("cue-pack", "done") == (_WAV, "audio/wav")
        detail = store.pack_detail("cue-pack")
        assert detail is not None
        assert detail["meta"]["name"] == "Renamed"
        assert detail["animations"]["idle"]["content"] == "<svg id='v2'/>"

    def test_an_explicit_empty_sounds_map_removes_the_cue(self, tmp_path):
        store = self._seeded(tmp_path)
        assert store.save_pack(
            "cue-pack",
            {"meta": {"id": "cue-pack"}, "states": {"idle": "idle.svg"}, "sounds": {}},
            {"idle.svg": "<svg/>"},
        )
        assert store.pack_sounds("cue-pack") == {}

    def test_a_new_cue_in_the_save_wins_over_the_kept_one(self, tmp_path):
        store = self._seeded(tmp_path)
        assert store.save_pack(
            "cue-pack",
            {
                "meta": {"id": "cue-pack"},
                "states": {"idle": "idle.svg"},
                "sounds": {"done": "new.mp3"},
            },
            {"idle.svg": "<svg/>", "new.mp3": _b64(_MP3)},
        )
        assert store.pack_sound("cue-pack", "done") == (_MP3, "audio/mpeg")

    def test_a_kept_cue_does_not_clobber_a_file_the_save_supplies(self, tmp_path):
        """The save's own bytes win where names collide."""
        store = self._seeded(tmp_path)
        assert store.save_pack(
            "cue-pack",
            {"meta": {"id": "cue-pack"}, "states": {"idle": "idle.svg"}},
            {"idle.svg": "<svg/>", "d.wav": _b64(_OGG)},
        )
        # Map preserved from disk, bytes taken from the save: the reader sniffs
        # the bytes, so it reports the new container.
        assert store.pack_sound("cue-pack", "done") == (_OGG, "audio/ogg")

    def test_a_fresh_pack_with_no_sounds_gets_none(self, tmp_path):
        store = _store(tmp_path)
        assert store.save_pack(
            "fresh",
            {"meta": {"id": "fresh"}, "states": {"idle": "idle.svg"}},
            {"idle.svg": "<svg/>"},
        )
        assert store.pack_sounds("fresh") == {}


class TestAnUnreadableCueRefusesTheOverwrite:
    """A declared cue the reader cannot load is transient, not removed.

    Carrying only the readable cues forward would make that moment permanent: the
    overwrite replaces the pack and the unreadable cue is gone for good. The save
    refuses instead -- the same all-or-nothing rule the art files follow -- so a
    retry after the condition clears loses nothing.
    """

    def test_a_declared_but_unreadable_cue_blocks_an_editor_resave(self, tmp_path):
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        store = _store(tmp_path)
        real_read = st.AppearanceStore._read_pack_file

        def _cue_unreadable(self, pack_dir, filename):
            if str(filename).endswith(".wav"):
                return None  # what a locked file / IO error looks like to the reader
            return real_read(self, pack_dir, filename)

        # A context, not `monkeypatch.undo()`: undo reverts every record on the
        # shared instance, this session's fixtures included.
        with pytest.MonkeyPatch.context() as patched:
            patched.setattr(st.AppearanceStore, "_read_pack_file", _cue_unreadable)
            ok = store.save_pack(
                "cue-pack",
                {"meta": {"id": "cue-pack", "name": "Renamed"}, "states": {"idle": "idle.svg"}},
                {"idle.svg": "<svg id='v2'/>"},
            )
            assert ok is False
        # Nothing changed on disk: the cue file and the old manifest are intact.
        assert store.pack_sound("cue-pack", "done") == (_WAV, "audio/wav")
        detail = store.pack_detail("cue-pack")
        assert detail is not None and detail["meta"]["name"] == "Cue"

    @pytest.mark.parametrize(
        "filename",
        ["../escape.wav", "sub/dir.wav", ".hidden.wav", "cue.exe", "gone.wav", 7, None],
    )
    def test_junk_or_absent_cue_names_never_lock_the_pack(self, tmp_path, filename):
        """Refusal is for the transient case only, never for junk.

        The read path DROPS an unusable name or an absent file, so counting those
        as "declared" would make the junk permanent: the pack could never be
        re-saved from the editor or exported again, and neither surface offers a
        way to fix the manifest.
        """
        _write_pack(tmp_path, sounds={"done": filename}, files={"other.svg": "<svg/>"})
        store = _store(tmp_path)
        assert (
            store.save_pack(
                "cue-pack",
                {"meta": {"id": "cue-pack", "name": "Renamed"}, "states": {"idle": "idle.svg"}},
                {"idle.svg": "<svg id='v2'/>"},
            )
            is True
        )
        assert export_bundle(store, "cue-pack") is not None

    def test_a_cue_whose_bytes_are_junk_never_locks_the_pack(self, tmp_path):
        """The fourth branch: the file is there, reads fine, and is not audio.

        No retry turns a PNG into audio, so a refusal here is a dead end rather
        than a guard -- and the read path drops it, so the two must agree.
        """
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_PNG)})
        store = _store(tmp_path)
        assert store.pack_sounds("cue-pack") == {}
        assert (
            store.save_pack(
                "cue-pack",
                {"meta": {"id": "cue-pack", "name": "Renamed"}, "states": {"idle": "idle.svg"}},
                {"idle.svg": "<svg id='v2'/>"},
            )
            is True
        )
        assert export_bundle(store, "cue-pack") is not None

    def test_an_oversize_cue_never_locks_the_pack_either(self, tmp_path):
        """Same branch: readable text, content the cue cap refuses."""
        big = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (snd.MAX_SOUND_BYTES + 1)
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(big)})
        store = _store(tmp_path)
        assert (
            store.save_pack(
                "cue-pack",
                {"meta": {"id": "cue-pack"}, "states": {"idle": "idle.svg"}},
                {"idle.svg": "<svg/>"},
            )
            is True
        )
        assert export_bundle(store, "cue-pack") is not None

    def test_a_present_but_unreadable_cue_still_refuses(self, tmp_path):
        """The narrowing must not swallow the case the guard exists for."""
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        store = _store(tmp_path)
        real_read = st.AppearanceStore._read_pack_file

        def _cue_unreadable(self, pack_dir, filename):
            if str(filename).endswith(".wav"):
                return None
            return real_read(self, pack_dir, filename)

        with pytest.MonkeyPatch.context() as patched:
            patched.setattr(st.AppearanceStore, "_read_pack_file", _cue_unreadable)
            assert (
                store.save_pack(
                    "cue-pack",
                    {"meta": {"id": "cue-pack"}, "states": {"idle": "idle.svg"}},
                    {"idle.svg": "<svg/>"},
                )
                is False
            )

    def test_an_explicit_sounds_map_is_not_gated_on_readability(self, tmp_path):
        """The caller SAID what the cues are; a stale unreadable one is theirs to drop."""
        _write_pack(tmp_path, sounds={"done": "d.wav"}, files={"d.wav": _b64(_WAV)})
        store = _store(tmp_path)
        with pytest.MonkeyPatch.context() as patched:
            patched.setattr(st.AppearanceStore, "_read_pack_file", lambda *a: None)
            ok = store.save_pack(
                "cue-pack",
                {"meta": {"id": "cue-pack"}, "states": {"idle": "idle.svg"}, "sounds": {}},
                {"idle.svg": "<svg/>"},
            )
        assert ok is True


class TestTheShippedFixtureBundleStillImports:
    """``test/fixtures/appearance_packs/cue-demo.bundle.json`` is a real bundle.

    The PR's manual-verification steps and anyone reproducing the sound route by
    hand import THIS file, so it has to stay importable: a fixture that rots is
    worse than none, because the steps then fail for a reason that has nothing to
    do with the code under test. Its WAV is a genuine 8-bit mono 8 kHz file, so a
    browser handed the route's bytes actually plays something.
    """

    FIXTURE = (
        Path(__file__).resolve().parent / "fixtures" / "appearance_packs" / "cue-demo.bundle.json"
    )

    def test_it_imports_and_its_cue_is_playable(self, tmp_path):
        bundle = json.loads(self.FIXTURE.read_text("utf-8"))
        store = _store(tmp_path)
        assert import_bundle(store, bundle) == {"ok": True, "id": "cue-demo"}
        assert store.pack_sounds("cue-demo") == {"done": True}
        served = store.pack_sound("cue-demo", "done")
        assert served is not None
        raw, mime = served
        assert mime == "audio/wav"
        assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
        # ~1 KB, so a reader can see it is a cue and not a track.
        assert 500 < len(raw) < 4096

    def test_its_art_is_what_the_slot_route_would_serve(self, tmp_path):
        bundle = json.loads(self.FIXTURE.read_text("utf-8"))
        store = _store(tmp_path)
        assert import_bundle(store, bundle)["ok"] is True
        detail = store.pack_detail("cue-demo")
        assert detail is not None
        assert detail["animations"]["idle"]["format"] == "svg"


class TestSniffingIsTheOneRule:
    """One predicate decides "can this play", on every side of the boundary.

    The store reports presence through it, the route serves what it returns, and
    the importer refuses what it rejects -- which is what stops a bundle
    installing cues the reader will silently drop.
    """

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (_WAV, ".wav"),
            (_MP3, ".mp3"),
            (b"\xff\xfb\x90\x00", ".mp3"),  # a bare MPEG frame, no ID3 tag
            (_OGG, ".ogg"),
            (_PNG, ""),
            (b"", ""),
            (b"RIFF____NOTWAVE", ""),
        ],
    )
    def test_the_sniffer_reads_magic_bytes_only(self, raw, expected):
        assert snd.sniff_audio(raw) == expected

    def test_every_sniffable_container_has_a_served_type(self):
        assert set(snd.SOUND_MIME) == set(snd.SOUND_SUFFIXES)

    @pytest.mark.parametrize("junk", [None, 7, "", "not base64 !!", _b64(_PNG)])
    def test_unplayable_content_answers_none(self, junk):
        assert snd.sound_body(junk) is None

    @pytest.mark.parametrize(
        "content",
        [
            _b64(_WAV),
            _b64(_MP3),
            _b64(_OGG),
            _b64(_PNG),
            "not base64 !!",
            "",
            None,
            7,
            _b64(b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (snd.MAX_SOUND_BYTES + 1)),
        ],
    )
    def test_the_reader_and_the_importer_never_disagree(self, content):
        """A reason exists exactly when the cue will not play, and vice versa.

        The two sides need different things from one judgement -- the reader drops
        a bad cue, the importer has to say which mistake it was -- and the drift
        this pins is the expensive one: an importer that accepted what the reader
        drops installs a pack whose cues silently never fire, with a 200 that said
        it worked.
        """
        body, reason = snd.read_sound(content)
        assert (body is None) == bool(reason)
        assert snd.sound_body(content) == body
        problem = transfer_mod._sound_problem("done.wav", content)
        assert bool(problem) == bool(reason)
        if reason:
            assert reason in problem and "done.wav" in problem

    def test_the_importer_only_formats_the_reason(self):
        """No second decode at the boundary -- the message is the predicate's own.

        Pinned by identity rather than by re-listing the reasons, because a second
        copy of the decode is exactly what the module docstring warns drifts.
        """
        import inspect

        source = inspect.getsource(transfer_mod._sound_problem)
        assert "read_sound(" in source
        assert "b64decode" not in source and "sniff_audio" not in source
