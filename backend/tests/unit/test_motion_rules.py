"""Static locks on the frontend's motion layer.

Here for the same reason as `test_design_tokens.py`: this is the project's one
test runner, and the failure is one no single screenshot shows. A card that
never lifts on hover looks exactly like a card that was never meant to.
"""

from __future__ import annotations

import re
from pathlib import Path

GLOBALS_CSS = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "globals.css"


def _css() -> str:
    return re.sub(r"/\*.*?\*/", " ", GLOBALS_CSS.read_text(), flags=re.S)


def _braced(css: str, opener: str) -> list[tuple[re.Match[str], int]]:
    """Each match of ``opener`` (which ends at a ``{``) with the index just past
    its closing brace, nested braces and all."""
    found = []
    for match in re.finditer(opener, css):
        depth, i = 1, match.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        found.append((match, i))
    return found


def test_no_animation_keeps_a_transform_or_filter_once_it_has_ended():
    """A `forwards` or `both` fill holds the last keyframe for good, and an
    animated value outranks every ordinary rule. Holding `transform: none` or
    `filter: blur(0)` is how every staggered card on the dashboard and budgets
    screens silently lost its hover lift and shadow."""
    css = _css()
    holds_a_pose = {
        match.group(1)
        for match, end in _braced(css, r"@keyframes\s+([\w-]+)\s*\{")
        if re.search(r"\b(transform|filter)\s*:", css[match.end() : end])
    }
    assert "noir-rise" in holds_a_pose, "keyframe parsing broke"

    offenders = [
        declaration.strip()
        for declaration in re.findall(r"animation:\s*([^;]+);", css)
        if set(declaration.split()) & holds_a_pose
        and re.search(r"\b(forwards|both)\b", declaration)
    ]
    assert offenders == []


def test_nothing_animates_for_a_reader_who_asked_for_less_motion():
    """Every animation sits inside `prefers-reduced-motion: no-preference`.
    Four designs each with their own entrances is a lot of rules to keep
    inside it by hand, and one that slips out plays for exactly the people
    whose systems asked for none."""
    css = _css()
    allowed = [
        (match.start(), end)
        for match, end in _braced(css, r"@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{")
    ]
    assert allowed, "media query parsing broke"

    outside = [
        match.group(0)
        for match in re.finditer(r"animation(?:-name)?\s*:\s*[^;]+;", css)
        if not any(start <= match.start() < end for start, end in allowed)
    ]
    assert outside == []
