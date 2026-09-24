"""yt-dlp extractor override: Peloton's signed stream URL (ytdrivarr#40).

ytdrivarr projects this tree next to a Peloton library's ``subscriptions.yaml``
(``<library>/.ytdrivarr/ytdlp-plugins``); the downloader puts that directory on
``PYTHONPATH`` and yt-dlp loads it as a plugin, both for the ``yt-dlp`` CLI and
for ytdl-sub's in-process ``YoutubeDL``.

Why: since ~2026-08-26 Akamai rejects the manifest URL the built-in
``PelotonIE`` builds (``vod_stream_url?hdnea=<POST /api/subscription/stream
token>``) with ``403 Access Denied``, while login, the session and the class
metadata still work. Peloton's members site now asks
``POST /api/ride/<id>/stream?content_type=on_demand`` for a ready-signed
manifest URL (an ``hdnts`` token), which serves the same master playlist.

This subclass keeps everything else upstream does (session start with the
delivered bearer + cookies, the password login fallback, metadata, cues,
chapters) and replaces only the manifest step. Live classes have no
``vod_stream_url`` and are left to the upstream code unchanged.
"""

import json

from yt_dlp.extractor.peloton import PelotonIE
from yt_dlp.networking.exceptions import HTTPError
from yt_dlp.utils import (
    ExtractorError,
    float_or_none,
    str_or_none,
    traverse_obj,
    url_or_none,
)


class _YtdrivarrPelotonIE(PelotonIE, plugin_name='ytdrivarr'):
    _SIGNED_STREAM_URL = 'https://api.onepeloton.com/api/ride/{}/stream?content_type=on_demand'

    def _signed_stream_url(self, video_id):
        try:
            stream = self._download_json(
                self._SIGNED_STREAM_URL.format(video_id), video_id,
                note='Requesting signed stream URL', data=b'')
        except ExtractorError as e:
            if isinstance(e.cause, HTTPError) and e.cause.status == 403:
                res = self._parse_json(
                    self._webpage_read_content(e.cause.response, None, video_id), video_id, fatal=False) or {}
                message = res.get('message') or 'Peloton refused the stream request (HTTP 403)'
                raise ExtractorError(message, expected=message == 'Stream limit reached') from e
            raise
        url = traverse_obj(stream, ('url', {url_or_none}))
        if not url:
            raise ExtractorError('Peloton returned no signed stream URL')
        return url

    def _real_extract(self, url):
        video_id = self._match_id(url)
        try:
            self._start_session(video_id)
        except ExtractorError as e:
            if isinstance(e.cause, HTTPError) and e.cause.status == 401:
                self._login(video_id)
                self._start_session(video_id)
            else:
                raise

        metadata = self._download_json(
            f'https://api.onepeloton.com/api/ride/{video_id}/details?stream_source=multichannel', video_id)
        ride_data = metadata.get('ride')
        if not ride_data:
            raise ExtractorError('Missing stream metadata')
        if not ride_data.get('vod_stream_url'):
            return super()._real_extract(url)

        stream_url = self._signed_stream_url(video_id)
        if ride_data.get('content_format') == 'audio':
            formats = [{
                'url': stream_url,
                'ext': 'm4a',
                'format_id': 'audio',
                'vcodec': 'none',
            }]
            subtitles = {}
        else:
            formats, subtitles = self._extract_m3u8_formats_and_subtitles(stream_url, video_id, 'mp4')

        if metadata.get('instructor_cues'):
            subtitles['cues'] = [{
                'data': json.dumps(metadata.get('instructor_cues')),
                'ext': 'json',
            }]

        category = ride_data.get('fitness_discipline_display_name')
        chapters = [{
            'start_time': segment.get('start_time_offset'),
            'end_time': segment.get('start_time_offset') + segment.get('length'),
            'title': segment.get('name'),
        } for segment in traverse_obj(metadata, ('segments', 'segment_list'))]

        return {
            'id': video_id,
            'title': ride_data.get('title'),
            'formats': formats,
            'thumbnail': url_or_none(ride_data.get('image_url')),
            'description': str_or_none(ride_data.get('description')),
            'creator': traverse_obj(ride_data, ('instructor', 'name')),
            'release_timestamp': ride_data.get('original_air_time'),
            'timestamp': ride_data.get('original_air_time'),
            'subtitles': subtitles,
            'duration': float_or_none(ride_data.get('length')),
            'categories': [category] if category else None,
            'tags': traverse_obj(ride_data, ('equipment_tags', ..., 'name')),
            'is_live': False,
            'chapters': chapters,
        }
