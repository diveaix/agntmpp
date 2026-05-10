/**
 * ./AGNT Protocol — Skill Loader
 *
 * Auto-discovers and loads .ts skill files from the skills/ directory.
 * Skills use the same ToolModule interface as built-in tools.
 * Supports hot-reload without server restart.
 */

import { readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import type { ToolModule, ToolDef, ToolResult } from './tools/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SKILLS_DIR = join(__dirname, 'skills')

interface LoadedSkill {
  name: string           // filename without extension
  filename: string       // full filename
  tools: ToolDef[]       // tools this skill provides
  handle: ToolModule['handle']
  loadedAt: Date
}

const loadedSkills: Map<string, LoadedSkill> = new Map()

/**
 * Load a single skill file. Returns the skill or throws.
 */
async function loadSkillFile(filepath: string): Promise<LoadedSkill> {
  const filename = basename(filepath)
  const name = filename.replace(/\.ts$/, '').replace(/\.js$/, '')

  // Dynamic import with cache-bust for hot-reload
  const cacheBust = `?t=${Date.now()}`
  const mod = await import(`${filepath}${cacheBust}`)

  const skillModule: ToolModule = mod.default
  if (!skillModule?.tools || !skillModule?.handle) {
    throw new Error(`Skill "${name}" must export default { tools, handle }`)
  }

  return {
    name,
    filename,
    tools: skillModule.tools,
    handle: skillModule.handle,
    loadedAt: new Date(),
  }
}

/**
 * Scan the skills/ directory and load all .ts files.
 * Called on server startup and on manual reload.
 */
export async function loadAllSkills(): Promise<{ loaded: string[]; errors: string[] }> {
  const loaded: string[] = []
  const errors: string[] = []

  if (!existsSync(SKILLS_DIR)) return { loaded, errors }

  const files = readdirSync(SKILLS_DIR)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_') && f !== 'README.md')

  for (const file of files) {
    try {
      const skill = await loadSkillFile(join(SKILLS_DIR, file))
      loadedSkills.set(skill.name, skill)
      loaded.push(`${skill.name} (${skill.tools.length} tools)`)
    } catch (e) {
      errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (loaded.length) console.log(`[Skills] Loaded: ${loaded.join(', ')}`)
  if (errors.length) console.log(`[Skills] Errors: ${errors.join('; ')}`)

  return { loaded, errors }
}

/**
 * Install a skill from a URL (GitHub raw, gist, any HTTP source).
 */
export async function installSkillFromUrl(url: string, name?: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)

  const code = await res.text()
  if (!code.includes('export default') && !code.includes('module.exports')) {
    throw new Error('File does not appear to export a valid skill module')
  }

  // Derive name from URL if not provided
  if (!name) {
    const urlParts = url.split('/')
    name = urlParts[urlParts.length - 1]
      .replace(/\.ts$/, '').replace(/\.js$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  const filepath = join(SKILLS_DIR, `${name}.ts`)
  writeFileSync(filepath, code, 'utf-8')

  // Load it immediately
  const skill = await loadSkillFile(filepath)
  loadedSkills.set(skill.name, skill)

  return `Installed "${skill.name}" with ${skill.tools.length} tools: ${skill.tools.map(t => t.name).join(', ')}`
}

/**
 * Remove a skill by name.
 */
export function removeSkill(name: string): string {
  const skill = loadedSkills.get(name)
  if (!skill) throw new Error(`Skill "${name}" not found`)

  const filepath = join(SKILLS_DIR, skill.filename)
  if (existsSync(filepath)) unlinkSync(filepath)
  loadedSkills.delete(name)

  return `Removed "${name}" (${skill.tools.length} tools)`
}

/**
 * Get all tools from loaded skills.
 */
export function getSkillTools(): ToolDef[] {
  const tools: ToolDef[] = []
  for (const skill of loadedSkills.values()) {
    tools.push(...skill.tools)
  }
  return tools
}

/**
 * Route a tool call to the appropriate skill handler.
 */
export async function handleSkillCall(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  for (const skill of loadedSkills.values()) {
    if (skill.tools.some(t => t.name === name)) {
      return skill.handle(name, args)
    }
  }
  return null
}

/**
 * Get info about all loaded skills.
 */
export function getSkillInfo(): { name: string; tools: string[]; loadedAt: string }[] {
  return [...loadedSkills.values()].map(s => ({
    name: s.name,
    tools: s.tools.map(t => t.name),
    loadedAt: s.loadedAt.toISOString(),
  }))
}

/**
 * Get count of loaded skills.
 */
export function getSkillCount(): number {
  return loadedSkills.size
}
