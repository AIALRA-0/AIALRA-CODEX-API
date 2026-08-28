from pathlib import Path
import re
import sys


def main() -> int:
    skill_dir = Path(sys.argv[1])
    skill_file = skill_dir / "SKILL.md"
    metadata_file = skill_dir / "agents" / "openai.yaml"
    if not skill_file.is_file() or not metadata_file.is_file():
        raise SystemExit("Skill requires SKILL.md and agents/openai.yaml")
    content = skill_file.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if not match:
        raise SystemExit("SKILL.md frontmatter is invalid")
    frontmatter = match.group(1)
    if "name: aialra-model-router" not in frontmatter or "description:" not in frontmatter:
        raise SystemExit("Skill name or description is missing")
    if "TODO" in content:
        raise SystemExit("Skill still contains TODO markers")
    print("Skill is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
