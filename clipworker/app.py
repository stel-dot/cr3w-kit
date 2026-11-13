# CR3W Clip Worker: finds streamer moments, turns them into Shorts, builds weekly compilations.
# Runs next to n8n on the CR3W server. n8n calls it at http://clipworker:8000 (private).
# Only GET /clips/<file> is reachable from the internet (through Caddy on the City host).
import glob, json, math, os, re, shutil, subprocess, threading, time, urllib.request
from flask import Flask, abort, jsonify, request, send_from_directory
from PIL import Image, ImageDraw, ImageFont

DATA = os.environ.get('DATA', '/data')
CLIPS, SRC, WORK = f'{DATA}/clips', f'{DATA}/src', f'{DATA}/work'
for d in (CLIPS, SRC, WORK):
    os.makedirs(d, exist_ok=True)
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
PUBLIC = os.environ.get('PUBLIC_BASE', 'https://city.cr3winc.com').rstrip('/')
KEEP_DAYS = int(os.environ.get('KEEP_DAYS', '21'))
W, H = 1080, 1920
LOCK = threading.Lock()
app = Flask(__name__)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'


def safe_id(s):
    return re.sub(r'[^A-Za-z0-9_-]', '_', str(s))[:80]


def run(cmd, timeout=900):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip().splitlines()[-1][:400] if (p.stderr or p.stdout).strip() else f'{cmd[0]} failed')
    return p.stdout


def ytdlp_args():
    a = ['yt-dlp', '--no-warnings', '--no-progress', '--socket-timeout', '30']
    if os.path.exists(f'{DATA}/cookies.txt'):
        a += ['--cookies', f'{DATA}/cookies.txt']
    return a


def ytdlp_json(args, timeout=240):
    return json.loads(run(ytdlp_args() + ['-J'] + args, timeout))


def probe(path):
    j = json.loads(run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 60))
    v = next((s for s in j['streams'] if s['codec_type'] == 'video'), None)
    a = any(s['codec_type'] == 'audio' for s in j['streams'])
    return {'w': int(v['width']), 'h': int(v['height']), 'dur': float(j['format'].get('duration') or 0), 'audio': a}


# ---------------------------------------------------------------- scouting
def scout_twitch(handle, n):
    url = f'https://www.twitch.tv/{handle}/clips?filter=clips&range=7d'
    data = ytdlp_json(['--flat-playlist', '--playlist-end', str(n * 3), url])
    out = []
    for i, e in enumerate(data.get('entries') or []):
        cid = e.get('id') or (e.get('url') or '').rstrip('/').split('/')[-1]
        if not cid:
            continue
        out.append({'id': 'tw_' + safe_id(cid), 'platform': 'twitch', 'url': e.get('url') or f'https://clips.twitch.tv/{cid}',
                    'title': e.get('title') or '', 'views': e.get('view_count') or 0, 'rank': i,
                    'duration': e.get('duration') or 0, 'created': e.get('timestamp') or 0, 'start': None, 'end': None})
    return out[:n * 2]


def scout_kick(handle, n):
    req = urllib.request.Request(f'https://kick.com/api/v2/channels/{handle}/clips?sort=view&time=week',
                                 headers={'User-Agent': UA, 'Accept': 'application/json'})
    data = json.loads(urllib.request.urlopen(req, timeout=30).read())
    out = []
    for i, c in enumerate(data.get('clips') or []):
        out.append({'id': 'kk_' + safe_id(c.get('id')), 'platform': 'kick',
                    'url': c.get('video_url') or c.get('clip_url') or f'https://kick.com/{handle}/clips/{c.get("id")}',
                    'page': f'https://kick.com/{handle}/clips/{c.get("id")}',
                    'title': c.get('title') or '', 'views': c.get('view_count') or c.get('views') or 0, 'rank': i,
                    'duration': c.get('duration') or 0, 'created': c.get('created_at') or 0, 'start': None, 'end': None})
    return out[:n * 2]


def heat_peaks(heat, dur, count, win=40):
    pts = sorted(heat, key=lambda p: p.get('value', 0), reverse=True)
    picks = []
    for p in pts:
        c = (p['start_time'] + p['end_time']) / 2
        if c < 20 or c > dur - 10:  # skip intros/outros
            continue
        if all(abs(c - q) > 150 for q in picks):
            picks.append(c)
        if len(picks) >= count:
            break
    return [(max(0, c - win * .45), min(dur, c + win * .55)) for c in picks]


def scout_youtube(handle, n):
    out, seen, errs = [], set(), []
    for tab in ('streams', 'videos'):
        try:
            lst = ytdlp_json(['--flat-playlist', '--playlist-end', '3', f'https://www.youtube.com/@{handle}/{tab}'])
        except Exception as ex:
            errs.append(f'{tab} list: {ex}')
            continue
        for e in lst.get('entries') or []:
            vid = e.get('id')
            if not vid or vid in seen:
                continue
            seen.add(vid)
            try:
                full = ytdlp_json(['--skip-download', f'https://www.youtube.com/watch?v={vid}'])
            except Exception as ex:
                errs.append(f'{vid}: {ex}')
                continue
            if full.get('is_live'):
                continue
            ts = full.get('timestamp') or 0
            if ts and time.time() - ts > 8 * 86400:
                continue
            dur = full.get('duration') or 0
            for k, (s, e2) in enumerate(heat_peaks(full.get('heatmap') or [], dur, 2)):
                out.append({'id': f'yt_{safe_id(vid)}_{int(s)}', 'platform': 'youtube', 'url': f'https://www.youtube.com/watch?v={vid}',
                            'title': full.get('title') or '', 'views': full.get('view_count') or 0, 'rank': k,
                            'duration': round(e2 - s), 'created': ts, 'start': round(s, 1), 'end': round(e2, 1)})
    if not out and errs:
        raise RuntimeError(' | '.join(errs)[:400])
    return out[:n * 2]


SCOUTS = {'twitch': scout_twitch, 'kick': scout_kick, 'youtube': scout_youtube}


@app.post('/scout')
def scout():
    body = request.get_json(force=True) or {}
    per = int(body.get('per', 5))
    clips, errors = [], []
    for s in body.get('streamers', []):
        fn = SCOUTS.get(s.get('platform'))
        if not fn:
            errors.append({'streamer': s.get('name'), 'error': 'unknown platform'})
            continue
        try:
            for c in fn(s['handle'], per):
                c.update({'streamer': s['name'], 'handle': s['handle'], 'source_platform': s['platform']})
                clips.append(c)
        except Exception as e:
            errors.append({'streamer': s.get('name'), 'error': str(e)[:300]})
    return jsonify({'clips': clips, 'errors': errors})


# ---------------------------------------------------------------- building a Short
def download(job):
    path = f"{SRC}/{job['id']}.mp4"
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    url, s, e = job['url'], job.get('start'), job.get('end')
    if url.endswith('.mp4') or '.m3u8' in url:
        cmd = ['ffmpeg', '-y', '-loglevel', 'error']
        if s is not None:
            cmd += ['-ss', str(s)]
        cmd += ['-i', url]
        if s is not None and e is not None:
            cmd += ['-t', str(float(e) - float(s))]
        run(cmd + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', path], 900)
    else:
        cmd = ytdlp_args() + ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path]
        if s is not None and e is not None:
            cmd += ['--download-sections', f'*{s}-{e}', '--force-keyframes-at-cuts']
        run(cmd + [url], 900)
    if not os.path.exists(path):
        hits = glob.glob(f"{SRC}/{job['id']}.*")
        if not hits:
            raise RuntimeError('download produced no file')
        os.replace(hits[0], path)
    return path


_model = None


def transcribe(src, wav):
    global _model
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 300)
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(os.environ.get('WHISPER_MODEL', 'base'), device='cpu', compute_type='int8', cpu_threads=2)
    # read the 16 kHz mono wav ourselves (avoids faster-whisper's PyAV decoder, which breaks with newer PyAV releases)
    import wave, numpy as np
    with wave.open(wav, 'rb') as f:
        audio = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segs, _ = _model.transcribe(audio, word_timestamps=True, vad_filter=True, beam_size=1)
    words = []
    for sg in segs:
        for w in sg.words or []:
            t = w.word.strip()
            if t:
                words.append({'t': t, 's': round(w.start, 2), 'e': round(w.end, 2)})
    return words


def ass_time(t):
    t = max(0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def make_ass(words, path, caption_y, replays=(), replay_y=660):
    # 1-2 words at a time, big, colour rotating white / yellow / cyan, small pop-in like the reference Shorts
    cols = ['&H00FFFFFF', '&H004DE1FF', '&H00FFE03F']  # ASS colours are BGR
    head = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
            'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            f'Style: Cap,Montserrat Black,108,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,7,4,2,60,60,{H - caption_y},1\n'
            'Style: Rep,Montserrat Black,62,&H001FD4FF,&H001FD4FF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,6,3,8,60,60,0,1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    groups, chunk = [], []
    def flush():
        if chunk:
            groups.append({'txt': ' '.join(w['t'] for w in chunk).replace('{', '').replace('}', ''),
                           's': chunk[0]['s'], 'e': max(chunk[-1]['e'], chunk[0]['s'] + .25)})
            chunk.clear()
    for i, w in enumerate(words):
        if chunk and (len(chunk) >= 2 or len(' '.join(x['t'] for x in chunk + [w])) > 14 or w['s'] - chunk[-1]['e'] > .35):
            flush()
        chunk.append(w)
        if re.search(r'[.!?,]$', w['t']):
            flush()
    flush()
    # keep each caption up until the next one starts (unless there's a real pause) so they don't flicker
    lines = []
    for i, g in enumerate(groups):
        nxt = groups[i + 1]['s'] if i + 1 < len(groups) else None
        e = nxt if nxt is not None and nxt - g['e'] < .6 else g['e'] + .15
        col = cols[i % len(cols)]
        lines.append(f"Dialogue: 0,{ass_time(g['s'])},{ass_time(e)},Cap,,0,0,0,,{{\\c{col}\\fscx82\\fscy82\\t(0,90,\\fscx100\\fscy100)}}{g['txt']}")
    for a, b in replays:
        lines.append(f"Dialogue: 1,{ass_time(a)},{ass_time(b)},Rep,,0,0,0,,{{\\pos(540,{replay_y})\\fad(150,150)}}INSTANT REPLAY")
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(lines) + '\n')


def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def make_title(text, path, box_h=380):
    img = Image.new('RGBA', (W, box_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    text = re.sub(r'\s+', ' ', text).strip().upper()
    size = 104
    while True:
        font = ImageFont.truetype(f'{FONTS}/Anton-Regular.ttf', size)
        lines = wrap(d, text, font, W - 110)
        lh = int(size * 1.08)
        if (len(lines) <= 3 and lh * len(lines) <= box_h - 20) or size <= 54:
            break
        size -= 6
    lines = lines[:3]
    y = (box_h - lh * len(lines)) // 2
    for ln in lines:
        x = (W - d.textlength(ln, font=font)) / 2
        d.text((x + 5, y + 7), ln, font=font, fill=(0, 0, 0, 170), stroke_width=12, stroke_fill=(0, 0, 0, 170))
        d.text((x, y), ln, font=font, fill=(255, 212, 31, 255), stroke_width=9, stroke_fill=(0, 0, 0, 255))
        y += lh
    img.save(path)


def hook_from(title, streamer):
    t = re.sub(r'https?://\S+|@\w+|#\w+', '', title or '').strip(' -|:')
    t = re.sub(r'\s+', ' ', t)
    if len(t) < 6 or t.lower() in ('clip', 'lol', 'lmao', 'w', 'bro'):
        t = 'went crazy on stream'
    if streamer and streamer.split()[0].lower() not in t.lower():
        t = f'{streamer}: {t}'
    return t[:90]


def extend_to(src, info, work, min_len):
    """Clips shorter than min_len get an instant replay: the end of the clip again,
    slowed to 0.75x and zoomed in a little, until the Short reaches min_len."""
    d = info['dur']
    if d >= min_len or d < 4:
        return src, info, []
    parts, total = [(0.0, d, 1.0, False)], d
    while total < min_len:
        rem = min_len + 0.3 - total
        L = min(d, rem * 0.75)
        parts.append((d - L, d, 0.75, True))
        total += L / 0.75
    w, h = info['w'] - info['w'] % 2, info['h'] - info['h'] % 2
    zw, zh = int(w * 1.12) // 2 * 2, int(h * 1.12) // 2 * 2
    fc, ins, replays, t = [], [], [], 0.0
    for i, (a, b, sp, rep) in enumerate(parts):
        v = f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{sp},fps=30,scale={w}:{h}'
        if rep:
            v += f',scale={zw}:{zh},crop={w}:{h}'
            replays.append((t, t + (b - a) / sp))
        fc.append(v + f',setsar=1[v{i}]')
        ins.append(f'[v{i}]')
        if info['audio']:
            fc.append(f'[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,atempo={sp},aresample=44100[a{i}]')
            ins.append(f'[a{i}]')
        t += (b - a) / sp
    n = len(parts)
    fc.append(''.join(ins) + f'concat=n={n}:v=1:a={1 if info["audio"] else 0}' + ('[v][a]' if info['audio'] else '[v]'))
    out = f'{work}/extended.mp4'
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-filter_complex', ';'.join(fc), '-map', '[v]']
    if info['audio']:
        cmd += ['-map', '[a]', '-c:a', 'aac']
    run(cmd + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out], 900)
    return out, probe(out), replays


def render_short(job):
    jid = safe_id(job['id'])
    job['id'] = jid
    out = f'{CLIPS}/{jid}.mp4'
    src = download(job)
    info = probe(src)
    work = f'{WORK}/{jid}'
    os.makedirs(work, exist_ok=True)
    src, info, replays = extend_to(src, info, work, float(job.get('min_seconds') or 30))
    dur = min(info['dur'], float(job.get('max_seconds') or 170))
    words = []
    if info['audio'] and not job.get('no_captions'):
        try:
            words = transcribe(src, f'{work}/a.wav')
        except Exception as e:
            words = []
            job['caption_error'] = str(e)[:200]
    title_y, title_h = 190, 380
    landscape = info['w'] / info['h'] >= 1.2
    if landscape:
        fg_h, fg_y = 960, 600
        fg = f'scale=-2:{fg_h},crop=min(iw\\,{W}):{fg_h}'
        cap_y = fg_y + fg_h - 150
    else:
        fg_h, fg_y = 1290, 590
        fg = f'scale={W}:-2,crop={W}:min(ih\\,{fg_h})'
        cap_y = fg_y + fg_h - 230
    make_title(job.get('hook') or hook_from(job.get('title'), job.get('streamer')), f'{work}/title.png', title_h)
    make_ass(words, f'{work}/cap.ass', cap_y, replays, fg_y + 70)
    fc = (f'[0:v]fps=30,split[a][b];'
          f'[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},hflip,gblur=sigma=30,eq=brightness=-0.10:saturation=1.15[bg];'
          f'[b]{fg}[fg];[bg][fg]overlay=(W-w)/2:{fg_y}+({fg_h}-h)/2[v1];'
          f'[v1][1:v]overlay=0:{title_y}[v2];'
          f"[v2]subtitles=filename={work}/cap.ass:fontsdir={FONTS}[v]")
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-i', f'{work}/title.png', '-filter_complex', fc, '-map', '[v]']
    if info['audio']:
        cmd += ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k']
    cmd += ['-t', f'{dur:.2f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '4500k', '-bufsize', '9M',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    run(cmd, 1800)
    shutil.rmtree(work, ignore_errors=True)
    return {'ok': True, 'id': jid, 'file': os.path.basename(out), 'url': f'{PUBLIC}/clips/{os.path.basename(out)}',
            'duration': round(dur, 1), 'captions': len(words), 'size_mb': round(os.path.getsize(out) / 1e6, 1), 'replays': len(replays),
            'caption_error': job.get('caption_error')}


@app.post('/render')
def render():
    job = request.get_json(force=True) or {}
    if not job.get('id') or not job.get('url'):
        return jsonify({'ok': False, 'error': 'id and url are required'}), 400
    with LOCK:
        try:
            return jsonify(render_short(job))
        except Exception as e:
            return jsonify({'ok': False, 'id': job.get('id'), 'error': str(e)[:500]}), 500


# ---------------------------------------------------------------- weekly compilation (16:9)
def card(text, sub, path):
    img = Image.new('RGB', (1920, 1080), (8, 8, 12))
    d = ImageDraw.Draw(img)
    f1 = ImageFont.truetype(f'{FONTS}/Anton-Regular.ttf', 120)
    f2 = ImageFont.truetype(f'{FONTS}/Montserrat-Black.ttf', 44)
    lines = wrap(d, text.upper(), f1, 1700)[:3]
    y = 540 - len(lines) * 70 - 30
    for ln in lines:
        d.text(((1920 - d.textlength(ln, font=f1)) / 2, y), ln, font=f1, fill=(255, 212, 31), stroke_width=6, stroke_fill=(0, 0, 0))
        y += 140
    if sub:
        d.text(((1920 - d.textlength(sub, font=f2)) / 2, y + 20), sub, font=f2, fill=(230, 230, 240))
    img.save(path)


def lower_third(name, path):
    img = Image.new('RGBA', (1920, 1080), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(f'{FONTS}/Montserrat-Black.ttf', 46)
    t = name.upper()
    w = d.textlength(t, font=f)
    d.rounded_rectangle((50, 950, 50 + w + 60, 1030), 14, fill=(0, 0, 0, 170))
    d.text((80, 962), t, font=f, fill=(255, 212, 31))
    img.save(path)


@app.post('/compile')
def compile_video():
    body = request.get_json(force=True) or {}
    cid = safe_id(body.get('id') or time.strftime('comp_%Y%m%d'))
    items = [i for i in body.get('items', []) if os.path.exists(f"{SRC}/{safe_id(i.get('id'))}.mp4")]
    if not items:
        return jsonify({'ok': False, 'error': 'none of those clips are on the server any more'}), 400
    with LOCK:
        work = f'{WORK}/{cid}'
        os.makedirs(work, exist_ok=True)
        try:
            parts = []
            card(body.get('title') or 'Best moments this week', body.get('subtitle') or '', f'{work}/card.png')
            run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-t', '3', '-i', f'{work}/card.png', '-f', 'lavfi', '-t', '3', '-i',
                 'anullsrc=r=48000:cl=stereo', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                 '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', f'{work}/p000.mp4'])
            parts.append(f'{work}/p000.mp4')
            total = 3
            for k, it in enumerate(items, 1):
                src = f"{SRC}/{safe_id(it['id'])}.mp4"
                info = probe(src)
                lower_third(it.get('streamer') or '', f'{work}/lt{k}.png')
                fc = ('[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[v0];'
                      '[v0][1:v]overlay=0:0:enable=\'lt(t,4)\',format=yuv420p[v]')
                cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-i', f'{work}/lt{k}.png']
                if not info['audio']:
                    cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
                cmd += ['-filter_complex', fc, '-map', '[v]', '-map', '0:a:0' if info['audio'] else '2:a', '-t', f"{info['dur']:.2f}",
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-ar', '48000', '-ac', '2', f'{work}/p{k:03d}.mp4']
                run(cmd, 1800)
                parts.append(f'{work}/p{k:03d}.mp4')
                total += info['dur']
            with open(f'{work}/list.txt', 'w') as f:
                f.write(''.join(f"file '{p}'\n" for p in parts))
            out = f'{CLIPS}/{cid}.mp4'
            run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{work}/list.txt', '-c', 'copy', '-movflags', '+faststart', out], 1800)
            return jsonify({'ok': True, 'id': cid, 'file': os.path.basename(out), 'url': f'{PUBLIC}/clips/{os.path.basename(out)}',
                            'duration': round(total, 1), 'clips': len(items), 'size_mb': round(os.path.getsize(out) / 1e6, 1)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:500]}), 500
        finally:
            shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- files, health, cleanup
@app.get('/clips/<path:name>')
def clip_file(name):
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.mp4', name):
        abort(404)
    return send_from_directory(CLIPS, name, mimetype='video/mp4', as_attachment=request.args.get('dl') == '1')


@app.get('/health')
def health():
    du = shutil.disk_usage(DATA)
    return jsonify({'ok': True, 'clips': len(os.listdir(CLIPS)), 'free_gb': round(du.free / 1e9, 1),
                    'cookies': os.path.exists(f'{DATA}/cookies.txt'), 'replay': True})


def cleanup_loop():
    while True:
        cut = time.time() - KEEP_DAYS * 86400
        for d in (CLIPS, SRC):
            for p in glob.glob(f'{d}/*'):
                try:
                    if os.path.getmtime(p) < cut:
                        os.remove(p)
                except OSError:
                    pass
        time.sleep(6 * 3600)


if __name__ == '__main__':
    threading.Thread(target=cleanup_loop, daemon=True).start()
    app.run(host='0.0.0.0', port=8000, threaded=True)
