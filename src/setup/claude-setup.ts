/**
 * Claude setup readers — MCP servers + skills declared on disk.
 * Sources: CodeBurn optimize / PR #79 (claude.json mcpServers + projects[].mcpServers)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, home } from "../providers/_paths.js";

export interface DeclaredMcp {
  name: string;
  scope: string;
}

export interface DeclaredSkill {
  name: string;
  path: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function listClaudeMcps(): DeclaredMcp[] {
  const out: DeclaredMcp[] = [];
  const seen = new Set<string>();

  const add = (name: string, scope: string) => {
    const key = `${scope}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, scope });
  };

  const claudeJson = readJson(home(".claude.json"));
  if (claudeJson) {
    const top = claudeJson.mcpServers as Record<string, unknown> | undefined;
    if (top) for (const name of Object.keys(top)) add(name, "user");

    const projects = claudeJson.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
    if (projects) {
      for (const [cwd, cfg] of Object.entries(projects)) {
        if (cfg?.mcpServers) {
          for (const name of Object.keys(cfg.mcpServers)) add(name, `project:${cwd}`);
        }
      }
    }
  }

  // project-local .mcp.json under cwd is harder; also check settings
  const settings = readJson(join(claudeDir(), "settings.json"));
  if (settings?.mcpServers && typeof settings.mcpServers === "object") {
    for (const name of Object.keys(settings.mcpServers as object)) add(name, "settings");
  }

  // Cursor mcp for cross-ref (optional)
  const cursorMcp = readJson(home(".cursor", "mcp.json"));
  if (cursorMcp?.mcpServers && typeof cursorMcp.mcpServers === "object") {
    for (const name of Object.keys(cursorMcp.mcpServers as object)) add(name, "cursor");
  }

  return out;
}

function listSkillsInDir(dir: string): DeclaredSkill[] {
  if (!existsSync(dir)) return [];
  const out: DeclaredSkill[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const skillMd = join(p, "SKILL.md");
      if (existsSync(skillMd)) out.push({ name, path: skillMd });
      else if (existsSync(p) && name.endsWith(".md")) {
        out.push({ name: name.replace(/\.md$/, ""), path: p });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function listClaudeSkills(): DeclaredSkill[] {
  const skills = [
    ...listSkillsInDir(join(claudeDir(), "skills")),
    ...listSkillsInDir(home(".claude", "skills")),
  ];
  // plugins cache skills — best-effort names from installed_plugins
  const plugins = join(claudeDir(), "plugins");
  if (existsSync(plugins)) {
    // feature-wave etc. at plugins root as dirs without SKILL — skip deep walk for v1
  }
  const map = new Map<string, DeclaredSkill>();
  for (const s of skills) map.set(s.name, s);
  return [...map.values()];
}
