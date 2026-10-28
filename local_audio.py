"""Local (Raspberry Pi) audio output discovery and playback helpers."""

import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.parse
import urllib.request

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))


def _find_audio_dir(collection=None):
    if collection == "music":
        names = ["music", "static/music", "audio", "static/audio"]
    else:
        names = ["audio", "static/audio", "music", "static/music"]
    candidates = [os.path.join(_MODULE_DIR, name) for name in names]
    for candidate in candidates:
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(_MODULE_DIR, "audio")


def list_local_audio_outputs():
    outputs = [{"id": "default", "label": "System Default Speaker", "default": True}]
    seen = {"default"}

    try:
        status = subprocess.run(["wpctl", "status"], capture_output=True, text=True, timeout=4).stdout
        in_audio = False
        in_sinks = False
        for line in status.splitlines():
            stripped = line.strip()
            if stripped.startswith("Audio"):
                in_audio = True
                continue
            if stripped.startswith("Video"):
                in_audio = False
                in_sinks = False
                continue
            if in_audio and stripped.endswith("Sinks:"):
                in_sinks = True
                continue
            if in_sinks and stripped.endswith(("Sources:", "Filters:", "Streams:")):
                break
            if not in_sinks:
                continue
            clean = stripped.lstrip("│├└─ ").strip()
            match = re.match(r"^\*?\s*(\d+)\.\s+(.+?)(?:\s+\[vol:[^\]]*\])?$", clean)
            if not match:
                continue
            node_id, label = match.group(1), match.group(2).strip()
            name = label
            try:
                info = subprocess.run(["wpctl", "inspect", node_id], capture_output=True, text=True, timeout=3).stdout
                name_match = re.search(r'node\.name\s*=\s*"([^"]+)"', info)
                if name_match:
                    name = name_match.group(1)
            except Exception:
                pass
            if name in seen:
                continue
            seen.add(name)
            outputs.append({"id": name, "label": label, "default": clean.startswith("*")})
    except Exception:
        pass

    if len(outputs) <= 1:
        try:
            result = subprocess.run(["pactl", "list", "short", "sinks"], capture_output=True, text=True, timeout=4).stdout
            for line in result.splitlines():
                parts = line.split("\t")
                if len(parts) >= 2 and parts[1] not in seen:
                    seen.add(parts[1])
                    outputs.append({"id": parts[1], "label": parts[1], "default": False})
        except Exception:
            pass

    if len(outputs) <= 1:
        try:
            result = subprocess.run(["aplay", "-l"], capture_output=True, text=True, timeout=4).stdout
            for line in result.splitlines():
                match = re.match(r"card (\d+):\s+(\S+)\s+\[(.+?)\],\s+device (\d+):\s+(.+)", line)
                if match:
                    card, short_name, _description, device, device_desc = match.groups()
                    name = "hw:%s,%s" % (card, device)
                    if name in seen:
                        continue
                    seen.add(name)
                    outputs.append({"id": name, "label": "%s - %s" % (short_name, device_desc.strip()), "default": False})
        except Exception:
            pass

    return outputs


def load_audio_bytes_from_url(url):
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
        path = parsed.path or ""

        if path.startswith("/api/tts/speak"):
            from gtts import gTTS
            import io

            query = urllib.parse.parse_qs(parsed.query)
            text = re.sub(r"\*[^*]*\*", "", query.get("text", ["Hello!"])[0]).strip() or "Hello!"
            voice = query.get("voice", ["ai_female_us"])[0]
            tld_map = {
                "ai_female_us": ("en", "com"),
                "ai_male_us": ("en", "us"),
                "ai_male_uk": ("en", "co.uk"),
                "ai_female_uk": ("en", "co.uk"),
            }
            lang, tld = tld_map.get(voice, ("en", "com"))
            tts = gTTS(text=text, lang=lang, tld=tld)
            buffer = io.BytesIO()
            tts.write_to_fp(buffer)
            return buffer.getvalue(), "audio/mpeg"

        if path.startswith("/audio/") or path.startswith("/music/"):
            filename = os.path.basename(urllib.parse.unquote(path.split("/", 2)[2]))
            collection = "music" if path.startswith("/music/") else "audio"
            file_path = os.path.join(_find_audio_dir(collection), filename)
            if os.path.isfile(file_path):
                with open(file_path, "rb") as handle:
                    data = handle.read()
                extension = os.path.splitext(file_path)[1].lower()
                content_type = {
                    ".mp3": "audio/mpeg",
                    ".wav": "audio/wav",
                    ".ogg": "audio/ogg",
                    ".m4a": "audio/mp4",
                    ".flac": "audio/flac",
                }.get(extension, "application/octet-stream")
                return data, content_type

        if parsed.scheme in ("http", "https"):
            import ssl

            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            request = urllib.request.Request(url, headers={"User-Agent": "audio-output/1.0"})
            with urllib.request.urlopen(request, timeout=15, context=context) as response:
                return response.read(), response.headers.get("Content-Type", "audio/mpeg")
    except Exception:
        pass

    return None, None


def play_audio_on_local_output(audio_bytes, content_type, speaker, volume=100):
    if not audio_bytes:
        return False

    target = str(speaker or "").replace("local:", "", 1).strip()
    if target in ("", "default", "browser", "local"):
        target = ""

    try:
        level = max(0.0, min(1.0, float(volume) / 100.0))
    except Exception:
        level = 1.0

    suffix = ".wav" if "wav" in (content_type or "") else ".ogg" if "ogg" in (content_type or "") else ".mp3"

    def worker():
        temporary_paths = []
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
                handle.write(audio_bytes)
                source_path = handle.name
            temporary_paths.append(source_path)
            play_path = source_path

            if suffix != ".wav" and shutil.which("ffmpeg"):
                wav_path = source_path + ".wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", source_path, wav_path],
                    timeout=30,
                )
                if os.path.isfile(wav_path) and os.path.getsize(wav_path) > 0:
                    play_path = wav_path
                    temporary_paths.append(wav_path)

            if shutil.which("pw-play"):
                command = ["pw-play", "--volume", "%.3f" % level]
                if target and not target.startswith("hw:"):
                    command += ["--target", target]
                command.append(play_path)
                subprocess.run(command, timeout=300)
            elif shutil.which("aplay") and play_path.endswith(".wav"):
                command = ["aplay"]
                if target.startswith("hw:"):
                    command += ["-D", target]
                command.append(play_path)
                subprocess.run(command, timeout=300)
            elif shutil.which("ffplay"):
                subprocess.run(
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", play_path],
                    timeout=300,
                )
        except Exception:
            pass
        finally:
            for path in temporary_paths:
                try:
                    os.unlink(path)
                except Exception:
                    pass

    threading.Thread(target=worker, daemon=True).start()
    return True
