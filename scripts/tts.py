#!/home/ryan/nanoclaw/venv/bin/python3
"""
Convert text to speech using Piper TTS.
Usage: python3 tts.py <output_ogg_path> <text>
       echo "text" | python3 tts.py <output_ogg_path>
"""
import sys
import os
import subprocess
import wave

MODEL_PATH = "/mnt/main-data/models/piper/en_US-lessac-medium.onnx"
CONFIG_PATH = "/mnt/main-data/models/piper/en_US-lessac-medium.onnx.json"

def text_to_ogg(text, output_ogg_path):
    # Generate WAV with piper
    wav_path = output_ogg_path.replace('.ogg', '.wav')

    from piper import PiperVoice
    voice = PiperVoice.load(MODEL_PATH, config_path=CONFIG_PATH)
    
    # Synthesize audio chunks
    chunks = list(voice.synthesize(text))
    if not chunks:
        raise RuntimeError("No audio generated")
    
    # Write WAV file using chunk metadata
    first_chunk = chunks[0]
    with wave.open(wav_path, 'wb') as wav_file:
        wav_file.setnchannels(first_chunk.sample_channels)
        wav_file.setsampwidth(first_chunk.sample_width)
        wav_file.setframerate(first_chunk.sample_rate)
        for chunk in chunks:
            wav_file.writeframes(chunk.audio_int16_bytes)

    # Convert WAV to OGG/Opus (Telegram prefers opus in ogg container)
    result = subprocess.run([
        'ffmpeg', '-y', '-i', wav_path,
        '-c:a', 'libopus', '-b:a', '64k',
        output_ogg_path
    ], capture_output=True)

    # Clean up wav
    if os.path.exists(wav_path):
        os.remove(wav_path)

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: tts.py <output_ogg_path> [text]", file=sys.stderr)
        sys.exit(1)

    output_path = sys.argv[1]

    if len(sys.argv) >= 3:
        text = " ".join(sys.argv[2:])
    else:
        text = sys.stdin.read().strip()

    if not text:
        print("No text provided", file=sys.stderr)
        sys.exit(1)

    text_to_ogg(text, output_path)
    print(f"Written to {output_path}")
