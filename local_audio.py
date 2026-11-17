"""Local (Raspberry Pi) audio output discovery and playback helpers."""

import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))

_current_process = None
_process_lock = threading.Lock()


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


def list_local_audio_inputs():
    inputs = [{"id": "default", "label": "System Default Microphone", "default": True}]
    seen = {"default"}

    try:
        status = subprocess.run(["wpctl", "status"], capture_output=True, text=True, timeout=4).stdout
        in_audio = False
        in_sources = False
        for line in status.splitlines():
            stripped = line.strip()
            if stripped.startswith("Audio"):
                in_audio = True
                continue
            if stripped.startswith("Video"):
                in_audio = False
                in_sources = False
                continue
            if in_audio and stripped.endswith("Sources:"):
                in_sources = True
                continue
            if in_sources and stripped.endswith(("Filters:", "Streams:", "Sinks:")):
                break
            if not in_sources:
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
            inputs.append({"id": name, "label": label, "default": clean.startswith("*")})
    except Exception:
        pass

    if len(inputs) <= 1:
        try:
            result = subprocess.run(["arecord", "-l"], capture_output=True, text=True, timeout=4).stdout
            for line in result.splitlines():
                match = re.match(r"card (\d+):\s+(\S+)\s+\[(.+?)\],\s+device (\d+):\s+(.+)", line)
                if match:
                    card, short_name, _description, device, device_desc = match.groups()
                    name = "hw:%s,%s" % (card, device)
                    if name in seen:
                        continue
                    seen.add(name)
                    inputs.append({"id": name, "label": "%s - %s" % (short_name, device_desc.strip()), "default": False})
        except Exception:
            pass

    return inputs


def record_local_audio(duration=3.5, device="default"):
    """Record an audio sample from the selected local microphone."""
    target = str(device or "").replace("local:", "", 1).strip()
    if target in ("", "browser", "local"):
        target = "default"

    tmp_wav = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            tmp_wav = fh.name

        recorded = False
        if shutil.which("pw-record") and target != "default" and not target.startswith("hw:"):
            cmd = ["pw-record", "--rate", "16000", "--channels", "1"]
            if target:
                cmd += ["--target", target]
            cmd.append(tmp_wav)
            try:
                proc = subprocess.Popen(cmd)
                time.sleep(float(duration))
                proc.send_signal(signal.SIGINT)
                proc.wait(timeout=3)
                if os.path.isfile(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                    recorded = True
            except Exception:
                pass

        if not recorded and shutil.which("arecord"):
            dev_arg = target if target and target != "default" else "default"
            if "PIXY" in dev_arg or "pixy" in dev_arg.lower():
                dev_arg = "dsnoop:CARD=PIXY,DEV=0"
            cmd = [
                "arecord", "-q", "-d", str(max(1, int(duration))), "-f", "S16_LE",
                "-r", "16000", "-c", "1", "-t", "wav"
            ]
            if dev_arg:
                cmd += ["-D", dev_arg]
            cmd.append(tmp_wav)
            try:
                subprocess.run(cmd, timeout=duration + 3)
                if os.path.isfile(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                    recorded = True
            except Exception:
                pass

        if recorded and os.path.isfile(tmp_wav):
            with open(tmp_wav, "rb") as fh:
                return fh.read()
    except Exception:
        pass
    finally:
        if tmp_wav and os.path.isfile(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass
    return None


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
                    "ai_female_uk": ("en", "co.uk"),
                    "ai_male_uk": ("en", "co.uk"),
                    "ai_female_au": ("en", "com.au"),
                    "ai_male_au": ("en", "com.au"),
                    "ai_female_ca": ("en", "ca"),
                    "ai_male_ca": ("en", "ca"),
                    "ai_female_in": ("en", "co.in"),
                    "ai_male_in": ("en", "co.in"),
                    "ai_female_ie": ("en", "ie"),
                    "ai_male_ie": ("en", "ie"),
                    "ai_female_za": ("en", "co.za"),
                    "ai_male_za": ("en", "co.za"),
                    "ai_female_ng": ("en", "com.ng"),
                    "ai_male_ng": ("en", "com.ng"),
                    "ai_female_nz": ("en", "co.nz"),
                    "ai_male_nz": ("en", "co.nz"),
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


def stop_local_audio():
    """Terminate any audio currently playing on the Raspberry Pi."""
    global _current_process
    with _process_lock:
        process = _current_process
        _current_process = None
    if process is None:
        return
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except Exception:
                process.kill()
    except Exception:
        pass


def play_audio_on_local_output(audio_bytes, content_type, speaker, volume=100):
    if not audio_bytes:
        return False

    stop_local_audio()

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

            command = None
            if shutil.which("pw-play"):
                command = ["pw-play", "--volume", "%.3f" % level]
                if target and not target.startswith("hw:"):
                    command += ["--target", target]
                command.append(play_path)
            elif shutil.which("aplay") and play_path.endswith(".wav"):
                command = ["aplay"]
                if target.startswith("hw:"):
                    command += ["-D", target]
                command.append(play_path)
            elif shutil.which("ffplay"):
                command = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", play_path]

            if command:
                global _current_process
                process = subprocess.Popen(command)
                with _process_lock:
                    _current_process = process
                try:
                    process.wait(timeout=300)
                finally:
                    with _process_lock:
                        if _current_process is process:
                            _current_process = None
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


# ---------------------------------------------------------------------
# Multi-accent speech synthesis (Edge-TTS neural & gTTS fallback)
# ---------------------------------------------------------------------
_TTS_CACHE = {}

VOICE_MAP = {
    'ai_butler_uk': ('en-GB-RyanNeural', 'en', 'co.uk'),
    'ai_female_uk': ('en-GB-SoniaNeural', 'en', 'co.uk'),
    'ai_male_uk': ('en-GB-RyanNeural', 'en', 'co.uk'),
    'ai_female_us': ('en-US-JennyNeural', 'en', 'com'),
    'ai_male_us': ('en-US-GuyNeural', 'en', 'us'),
    'ai_female_au': ('en-AU-NatashaNeural', 'en', 'com.au'),
    'ai_male_au': ('en-AU-WilliamMultilingualNeural', 'en', 'com.au'),
    'ai_female_ca': ('en-CA-ClaraNeural', 'en', 'ca'),
    'ai_male_ca': ('en-CA-LiamNeural', 'en', 'ca'),
    'ai_female_in': ('en-IN-NeerjaNeural', 'en', 'co.in'),
    'ai_male_in': ('en-IN-PrabhatNeural', 'en', 'co.in'),
    'ai_female_ie': ('en-IE-EmilyNeural', 'en', 'ie'),
    'ai_male_ie': ('en-IE-ConnorNeural', 'en', 'ie'),
    'ai_female_za': ('en-ZA-LeahNeural', 'en', 'co.za'),
    'ai_male_za': ('en-ZA-LukeNeural', 'en', 'co.za'),
    'ai_female_ng': ('en-NG-EzinneNeural', 'en', 'com.ng'),
    'ai_male_ng': ('en-NG-AbeoNeural', 'en', 'com.ng'),
    'ai_female_nz': ('en-NZ-MollyNeural', 'en', 'co.nz'),
    'ai_male_nz': ('en-NZ-MitchellNeural', 'en', 'co.nz'),
}

async def _edge_speak_async(text: str, voice_name: str) -> bytes:
    import edge_tts
    comm = edge_tts.Communicate(text, voice_name)
    chunks = []
    async for c in comm.stream():
        if c['type'] == 'audio':
            chunks.append(c['data'])
    return b''.join(chunks)

def synthesize_voice(text: str, voice_id: str = 'ai_butler_uk') -> bytes:
    clean = re.sub(r'\*[^*]*\*', '', text or 'Hello').strip() or 'Hello'
    voice_key = str(voice_id or 'ai_butler_uk').strip()
    cache_key = (clean, voice_key)
    if cache_key in _TTS_CACHE:
        return _TTS_CACHE[cache_key]

    edge_voice, lang, tld = VOICE_MAP.get(voice_key, ('en-GB-RyanNeural', 'en', 'co.uk'))
    try:
        import asyncio
        data = asyncio.run(_edge_speak_async(clean, edge_voice))
        if data:
            if len(_TTS_CACHE) > 128:
                _TTS_CACHE.pop(next(iter(_TTS_CACHE)))
            _TTS_CACHE[cache_key] = data
            return data
    except Exception:
        pass

    import io
    from gtts import gTTS
    mp3 = io.BytesIO()
    gTTS(text=clean, lang=lang, tld=tld).write_to_fp(mp3)
    data = mp3.getvalue()
    if len(_TTS_CACHE) > 128:
        _TTS_CACHE.pop(next(iter(_TTS_CACHE)))
    _TTS_CACHE[cache_key] = data
    return data
