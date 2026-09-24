"""Static locks on the frontend's colour tokens.

Here rather than in the frontend because this is the project's one test runner,
and these are the same kind of rule as `test_source_guards.py`: a property of the
source that no single screenshot would show breaking.
"""

from __future__ import annotations

import re
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parents[3] / "frontend"
GLOBALS_CSS = FRONTEND_ROOT / "src" / "app" / "globals.css"

#: WCAG 2.x AA for body-size text. Button labels here are 12-14px.
AA = 4.5


def _palettes() -> list[tuple[str, dict[str, str]]]:
    """Every rule that defines ``--accent``: the root default plus each design's
    light, system-dark and forced-dark blocks."""
    css = GLOBALS_CSS.read_text()
    found = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector = " ".join(re.sub(r"/\*.*?\*/", " ", match.group(1), flags=re.S).split())
        tokens = dict(re.findall(r"(--[\w-]+):\s*([^;]+);", match.group(2)))
        if "--accent" in tokens:
            found.append((selector, tokens))
    return found


def _luminance(hex_colour: str) -> float:
    h = hex_colour.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)

    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _ratio(a: str, b: str) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def test_every_palette_is_found():
    """Four designs, each light plus two routes to dark, plus the root default.
    A parser that silently matched nothing would let the next test pass."""
    assert len(_palettes()) == 13


def test_text_on_the_accent_meets_aa_contrast_in_every_palette():
    """White on the default brass was 2.43:1, and white passed in only one of
    the eight palettes -- so the Add button's label, and every other primary
    action's, was below AA almost everywhere."""
    failures = []
    for selector, tokens in _palettes():
        on_accent = tokens.get("--on-accent")
        if on_accent is None:
            failures.append(f"{selector}: no --on-accent")
            continue
        ratio = _ratio(tokens["--accent"], on_accent)
        if ratio < AA:
            failures.append(f"{selector}: {on_accent} on {tokens['--accent']} is {ratio:.2f}:1")
    assert failures == []


def test_no_component_puts_a_fixed_colour_on_the_accent():
    """The accent changes with the palette, so a label colour fixed in the
    component is right in at most one of them. That is how 22 buttons came to
    hard-code white."""
    fixed = re.compile(
        r'background: "var\(--accent\)",\s*color: "(?!var\(--on-accent\))[^"]*"'
    )
    offenders = [
        str(path.relative_to(FRONTEND_ROOT))
        for path in sorted((FRONTEND_ROOT / "src").rglob("*.tsx"))
        if fixed.search(path.read_text())
    ]
    assert offenders == []


#: Every token the components use as ink, and every surface ink sits on.
TEXT_TOKENS = (
    "--text-primary", "--text-secondary", "--text-muted", "--success-text",
    "--status-critical", "--status-warning", "--status-good", "--accent-text",
)
SURFACES = ("--surface-1", "--surface-2", "--page-plane")


def test_every_text_token_meets_aa_on_every_surface_in_every_palette():
    """The audit counted hundreds of axe contrast failures; nearly all traced
    back to a handful of inks -- muted grey, warning amber, the accent used as
    text -- falling under 4.5:1 on one surface or another. Fixed at the token,
    they are fixed everywhere the token is used."""
    failures = []
    for selector, tokens in _palettes():
        for ink in TEXT_TOKENS:
            for surface in SURFACES:
                if ink not in tokens:
                    failures.append(f"{selector}: no {ink}")
                    continue
                ratio = _ratio(tokens[ink], tokens[surface])
                if ratio < AA:
                    failures.append(f"{selector}: {ink} on {surface} is {ratio:.2f}:1")
    assert failures == []


def test_fill_colours_are_not_used_as_text():
    """--accent is a button fill and --series-N are chart hues; as ink they sat
    at 3:1 in several palettes. Text uses --accent-text."""
    ink = re.compile(r'color: [^,}]*"var\(--(?:accent|series-\d)\)"')
    offenders = []
    for path in sorted((FRONTEND_ROOT / "src").rglob("*.tsx")):
        for line in path.read_text().splitlines():
            if ink.search(line) and not re.search(r"\b(background|border|fill|stroke)", line):
                offenders.append(f"{path.relative_to(FRONTEND_ROOT)}: {line.strip()}")
    assert offenders == []


def test_content_is_not_dimmed_with_opacity():
    """Opacity dims ink below AA; `.dimmed` swaps to the muted ink instead.
    Opacity on a busy or disabled control is fine and excluded."""
    dimmed = re.compile(r"opacity: [^,}]*\? (?:0\.\d+|1) : (?:0\.\d+|1)")
    offenders = []
    for path in sorted((FRONTEND_ROOT / "src" / "components").rglob("*.tsx")):
        for line in path.read_text().splitlines():
            if dimmed.search(line) and not re.search(r"busy|saving|uploading|disabled|!account", line):
                offenders.append(f"{path.name}: {line.strip()}")
    assert offenders == []
