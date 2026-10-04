"""Static locks on the frontend's motion layer.

Here for the same reason as `test_design_tokens.py`: this is the project's one
test runner, and the failure is one no single screenshot shows. A card that
never lifts on hover looks exactly like a card that was never meant to.
"""

from __future__ import annotations

import re
from pathlib import Path

GLOBALS_CSS = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "globals.css"


def _keyframes(css: str) -> dict[str, str]:
    """Each ``@keyframes`` name mapped to its body, nested braces and all."""
    found = {}
    for match in re.finditer(r"@keyframes\s+([\w-]+)\s*\{", css):
        depth, i = 1, match.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        found[match.group(1)] = css[match.end() : i - 1]
    return found


def test_no_animation_keeps_a_transform_or_filter_once_it_has_ended():
    """A `forwards` or `both` fill holds the last keyframe for good, and an
    animated value outranks every ordinary rule. Holding `transform: none` or
    `filter: blur(0)` is how every staggered card on the dashboard and budgets
    screens silently lost its hover lift and shadow."""
    css = re.sub(r"/\*.*?\*/", " ", GLOBALS_CSS.read_text(), flags=re.S)
    holds_a_pose = {
        name
        for name, body in _keyframes(css).items()
        if re.search(r"\b(transform|filter)\s*:", body)
    }
    assert "noir-rise" in holds_a_pose, "keyframe parsing broke"

    offenders = [
        declaration.strip()
        for declaration in re.findall(r"animation:\s*([^;]+);", css)
        if set(declaration.split()) & holds_a_pose
        and re.search(r"\b(forwards|both)\b", declaration)
    ]
    assert offenders == []
