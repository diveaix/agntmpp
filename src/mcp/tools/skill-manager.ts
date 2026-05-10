/**
 * ./AGNT Protocol — Skill Manager Tool
 *
 * Install, list, remove, and reload skills at runtime.
 * Skills are .ts plugins dropped in src/mcp/skills/ or installed from URLs.
 */

import type { ToolModule } from './index.js'
import {
  loadAllSkills,
  installSkillFromUrl,
  removeSkill,
  getSkillInfo,
  getSkillTools,
} from '../skill-loader.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'skill_manager',
    description: 'Manage skills (plugins). Install from URL/GitHub, list loaded skills, remove, or hot-reload all.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['install', 'list', 'remove', 'reload'],
          description: 'Action to perform',
        },
        url: { type: 'string', description: 'URL to install skill from (for install). Supports GitHub raw URLs, gists, etc.' },
        name: { type: 'string', description: 'Skill name (for install override, or remove)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name !== 'skill_manager') return null

  try {
    switch (args.action as string) {

      case 'install': {
        if (!args.url) return err('Provide a URL to install from.\nExample: https://raw.githubusercontent.com/user/repo/main/skill.ts')

        const result = await installSkillFromUrl(args.url as string, args.name as string | undefined)
        return text(`✅ ${result}\n\n💡 The skill is now live — no restart needed.`)
      }

      case 'list': {
        const skills = getSkillInfo()
        const skillTools = getSkillTools()

        if (!skills.length) {
          return text(
            `📦 No skills installed.\n\n` +
            `Install one:\n` +
            `  skill_manager install url=https://raw.githubusercontent.com/.../skill.ts\n\n` +
            `Or drop a .ts file in src/mcp/skills/ and run: skill_manager reload`
          )
        }

        const lines: string[] = [`📦 Installed Skills (${skills.length})\n`]
        for (const s of skills) {
          lines.push(`  📋 ${s.name}`)
          lines.push(`    Tools: ${s.tools.join(', ')}`)
          lines.push(`    Loaded: ${s.loadedAt.slice(0, 19)}`)
          lines.push('')
        }
        lines.push(`Total skill tools: ${skillTools.length}`)
        return text(lines.join('\n'))
      }

      case 'remove': {
        if (!args.name) return err('Provide the skill name to remove')
        const result = removeSkill(args.name as string)
        return text(`✅ ${result}`)
      }

      case 'reload': {
        const { loaded, errors } = await loadAllSkills()
        const lines: string[] = [`🔄 Skills Reloaded\n`]
        if (loaded.length) {
          lines.push(`Loaded (${loaded.length}):`)
          for (const l of loaded) lines.push(`  ✅ ${l}`)
        } else {
          lines.push('No skills found in skills/ directory.')
        }
        if (errors.length) {
          lines.push(`\nErrors (${errors.length}):`)
          for (const e of errors) lines.push(`  ❌ ${e}`)
        }
        return text(lines.join('\n'))
      }

      default:
        return err(`Unknown action: ${args.action}`)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
