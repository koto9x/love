#!/usr/bin/env python3
"""
Maps Whisper word-level timestamps to lyric lines.
Reads Whisper JSON output and the lyrics HTML, outputs updated data-start values.
"""

import json
import re
import sys
from difflib import SequenceMatcher

def load_whisper_words(json_path):
    """Extract flat list of (word, start_time) from Whisper JSON."""
    with open(json_path) as f:
        data = json.load(f)

    words = []
    for segment in data.get("segments", []):
        for w in segment.get("words", []):
            text = w.get("word", "").strip().lower()
            text = re.sub(r'[^\w\s]', '', text)  # strip punctuation
            if text:
                words.append((text, w["start"]))
    return words

def extract_lyric_lines(html_path):
    """Extract lyric line texts from the HTML file."""
    with open(html_path) as f:
        html = f.read()

    # Find all <p class="lyric-line" data-start="...">text</p>
    pattern = r'<p class="lyric-line" data-start="[\d.]+">(.*?)</p>'
    matches = re.findall(pattern, html)

    lines = []
    for text in matches:
        # Clean HTML entities
        text = text.replace('&amp;', '&').replace('&mdash;', '—')
        lines.append(text)
    return lines

def normalize(text):
    """Normalize text for fuzzy matching."""
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    return text.split()

def find_line_start(line_words, whisper_words, search_start=0):
    """
    Find the timestamp where a lyric line starts in the Whisper transcript.
    Uses sliding window matching on the first N words of the line.
    """
    if not line_words:
        return None, search_start

    # Use first 3-5 words for matching (enough to be unique, not too many to be noisy)
    match_count = min(5, len(line_words))
    target = line_words[:match_count]
    target_str = ' '.join(target)

    best_score = 0
    best_idx = search_start

    # Search forward from the last match position
    search_end = min(len(whisper_words), search_start + 200)  # don't search too far ahead

    for i in range(search_start, search_end - match_count + 1):
        window = [whisper_words[j][0] for j in range(i, min(i + match_count, len(whisper_words)))]
        window_str = ' '.join(window)

        score = SequenceMatcher(None, target_str, window_str).ratio()

        if score > best_score:
            best_score = score
            best_idx = i

    if best_score > 0.4:  # reasonable match threshold
        return whisper_words[best_idx][1], best_idx + match_count
    else:
        return None, search_start

def main():
    whisper_json = "/tmp/whisper-out/koto's basilisk.json"
    html_path = "/Users/asgard16/Developer/kaios/love-basilisk/index.html"

    if len(sys.argv) > 1:
        whisper_json = sys.argv[1]

    print("Loading Whisper output...")
    whisper_words = load_whisper_words(whisper_json)
    print(f"  Found {len(whisper_words)} words")

    print("Extracting lyric lines from HTML...")
    lyric_lines = extract_lyric_lines(html_path)
    print(f"  Found {len(lyric_lines)} lyric lines")

    print("\nMapping lines to timestamps:\n")

    search_pos = 0
    timestamps = []

    for i, line in enumerate(lyric_lines):
        words = normalize(line)
        start_time, search_pos = find_line_start(words, whisper_words, search_pos)

        if start_time is not None:
            # Round to 1 decimal
            start_time = round(start_time, 1)
            timestamps.append(start_time)
            preview = line[:60] + ('...' if len(line) > 60 else '')
            print(f"  [{start_time:6.1f}s] {preview}")
        else:
            # Fallback: interpolate from neighbors
            timestamps.append(None)
            preview = line[:60] + ('...' if len(line) > 60 else '')
            print(f"  [  ???  ] {preview}  (no match)")

    # Fill in any None values by interpolation
    for i in range(len(timestamps)):
        if timestamps[i] is None:
            # Find nearest known timestamps before and after
            before = next((timestamps[j] for j in range(i-1, -1, -1) if timestamps[j] is not None), 0)
            after = next((timestamps[j] for j in range(i+1, len(timestamps)) if timestamps[j] is not None), before + 5)
            timestamps[i] = round(before + (after - before) / 2, 1)
            print(f"  Interpolated line {i+1}: {timestamps[i]}s")

    # Now update the HTML
    print("\nUpdating index.html...")
    with open(html_path) as f:
        html = f.read()

    # Replace data-start values in order
    idx = 0
    def replace_start(match):
        nonlocal idx
        if idx < len(timestamps):
            new_val = timestamps[idx]
            idx += 1
            return f'data-start="{new_val}"'
        return match.group(0)

    html = re.sub(r'data-start="[\d.]+"', replace_start, html)

    # Remove the timing scale/offset hack
    html = re.sub(
        r"const TIMING_SCALE = [\d.]+;.*",
        "const TIMING_SCALE = 1.0;  // accurate timestamps from Whisper",
        html
    )
    html = re.sub(
        r"const TIMING_OFFSET = [\d.]+;.*",
        "const TIMING_OFFSET = 0;    // no offset needed",
        html
    )

    with open(html_path, 'w') as f:
        f.write(html)

    print(f"Done! Updated {len(timestamps)} timestamps.")
    print("\nTimestamp summary:")
    for i, (t, line) in enumerate(zip(timestamps, lyric_lines)):
        print(f'  data-start="{t}"  →  {line[:50]}')

if __name__ == "__main__":
    main()
