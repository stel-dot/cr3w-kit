# CR3W Clip Worker: ffmpeg + yt-dlp + faster-whisper (speech-to-text, runs on the CPU, free)
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir flask pillow faster-whisper "yt-dlp[default]" deno
ENV HF_HOME=/models
# download the speech-to-text model once, at build time
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
WORKDIR /app
COPY . /app
# keep yt-dlp current (sites change often), then start
CMD ["sh", "-c", "pip install -q -U 'yt-dlp[default]' >/dev/null 2>&1; exec python app.py"]
