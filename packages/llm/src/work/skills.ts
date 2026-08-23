import { dirname, resolve } from "node:path";
import { recordConfigChange } from "../config-vcs";
import {
  writeWorkSkillFiles,
  type WorkSkillDraft,
} from "./skill-files";

export {
  normalizeSkillName,
  upsertWorkSkill,
  type WorkSkillDraft,
} from "./skill-files";

export async function writeWorkSkill(
  skillsRoot: string,
  draft: WorkSkillDraft,
): Promise<{ name: string; skillPath: string }> {
  const { name, skillPath } = await writeWorkSkillFiles(skillsRoot, draft);

  // CV0: auto-version the write. Best-effort — never fails the save.
  await recordConfigChange({
    workspaceRoot: dirname(resolve(skillsRoot)),
    paths: [`skills/${name}`],
    message: `Updated skill: ${name}`,
  });

  return { name, skillPath };
}
