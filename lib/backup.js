// Backup file for settings and skills. Firefox deletes storage.local when the add-on is uninstalled,
// so this is the way to carry them over a reinstall. Needs lib/settings.js and lib/skills.js.
"use strict";

const BACKUP_FORMAT = "pagemortem-backup";
const BACKUP_VERSION = 1;

async function makeBackup() {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported: new Date().toISOString(),
    settings: await loadSettings(),
    skills: await loadSkills(),
  };
}

/** Saved settings from a backup: known keys whose value has the default's type. Others are left at their defaults. */
function backupSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (key === "thinkingLevels") {
      if (v === null || (Array.isArray(v) && v.every((l) => typeof l === "string"))) out[key] = v;
    } else if (key === "hiddenButtons") {
      if (Array.isArray(v) && v.every((id) => typeof id === "string")) out[key] = v;
    } else if (key === "thinkingDefault") {
      if (v === null || typeof v === "string") out[key] = v;
    } else if (typeof v === typeof def && (typeof v !== "number" || Number.isFinite(v))) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Checks a backup file's text.
 * @returns {{settings:object, skills:object[], skipped:string[]}|{error:string}}
 */
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "This file isn't a PageMortem backup (not valid JSON)." };
  }
  if (data?.format !== BACKUP_FORMAT) return { error: "This file isn't a PageMortem backup." };
  if (data.version > BACKUP_VERSION) return { error: "This backup is from a newer PageMortem. Update the extension, then import it." };
  const skills = [];
  const skipped = [];
  for (const raw of Array.isArray(data.skills) ? data.skills : []) {
    const { skill, error } = normalizeSkill(raw);
    if (!skill) skipped.push(`${raw?.name || "unnamed skill"}: ${error}`);
    else if (skills.some((s) => s.name === skill.name)) skipped.push(`@${skill.name}: listed twice`);
    else skills.push(skill);
  }
  return { settings: backupSettings(data.settings), skills, skipped };
}

/**
 * Replaces the settings and adds the backup's skills, replacing saved skills of the same name. Other saved skills stay.
 * @returns {Promise<{settings:object, skills:object[], restored:number, skipped:string[]}>} what is saved now
 */
async function restoreBackup(parsed) {
  const settings = { ...DEFAULTS, ...parsed.settings };
  const list = await loadSkills();
  const skipped = [...parsed.skipped];
  const written = [];
  for (const skill of parsed.skills) {
    const at = list.findIndex((s) => s.name === skill.name);
    if (at >= 0) list[at] = skill;
    else if (list.length >= SKILL_LIMITS.skills) {
      skipped.push(`@${skill.name}: at most ${SKILL_LIMITS.skills} skills`);
      continue;
    } else list.push(skill);
    written.push(skill);
  }
  await browser.storage.local.set({
    settings,
    [SKILL_INDEX]: list.map((s) => s.name),
    ...Object.fromEntries(written.map((s) => [SKILL_KEY + s.name, s])),
  });
  return { settings, skills: list, restored: written.length, skipped };
}
