#!/home/ryan/nanoclaw/venv/bin/python3
"""
Transcribe audio file using faster-whisper.
Usage: python3 transcribe.py <audio_file_path>
Outputs: transcript text to stdout
"""
import sys
import os
import ctypes

def has_cuda():
    """Check if CUDA libraries are actually loadable."""
    try:
        ctypes.CDLL('libcublas.so.12')
        return True
    except OSError:
        pass
    try:
        ctypes.CDLL('libcublas.so.11')
        return True
    except OSError:
        pass
    return False

def transcribe(audio_path):
    from faster_whisper import WhisperModel
    if has_cuda():
        try:
            model = WhisperModel('medium', device='cuda', compute_type='float16')
        except Exception:
            model = WhisperModel('medium', device='cpu', compute_type='int8')
    else:
        model = WhisperModel('medium', device='cpu', compute_type='int8')
    
    segments, info = model.transcribe(audio_path, beam_size=5)
    transcript = ' '.join(segment.text.strip() for segment in segments)
    return transcript.strip()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: transcribe.py <audio_file>', file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(f'File not found: {audio_file}', file=sys.stderr)
        sys.exit(1)

    try:
        result = transcribe(audio_file)
        print(result)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
