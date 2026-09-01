// Built-in defaults.
//
// These are placeholders. Real hosts, usernames, key paths and remote directory
// layouts live in config/console.json, which is gitignored and loaded at start-up
// by the main process — see config/console.example.json for the shape.
//
// The app used to carry the real fleet inline: three production hosts, two by raw
// IP, each with `username: "root"`, one with the filename of its private key and
// its tunnel command. That is a complete map of an attack surface sitting in a
// renderer bundle, and no amount of access control on the servers makes it a
// reasonable thing to ship.

export const defaultServers = [
  {
    id: 'local',
    short: 'LO',
    title: 'Localhost',
    subtitle: 'config/console.json ile kendi sunucularınızı tanımlayın',
    host: '127.0.0.1',
    port: 22,
    username: 'deploy',
    status: 'Örnek',
    note: 'yapılandırılmadı'
  }
]

export const defaultProjects = []

/** Shape check, so a malformed console.json fails loudly at start-up. */
export function validateConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object') return ['config is not an object']

  const servers = config.servers
  if (!Array.isArray(servers) || servers.length === 0) errors.push('config.servers must be a non-empty array')
  else servers.forEach((s, i) => {
    if (!s.id) errors.push(`servers[${i}] has no id`)
    if (!s.host) errors.push(`servers[${i}] (${s.id || i}) has no host`)
    if (!s.username) errors.push(`servers[${i}] (${s.id || i}) has no username`)
  })

  const projects = config.projects
  if (projects !== undefined && !Array.isArray(projects)) errors.push('config.projects must be an array')
  else if (Array.isArray(projects)) {
    const ids = new Set((servers || []).map((s) => s.id))
    projects.forEach((p, i) => {
      if (!p.key) errors.push(`projects[${i}] has no key`)
      if (!p.script) errors.push(`projects[${i}] (${p.key || i}) has no script`)
      // A project pointing at a server that is not defined would otherwise fail
      // at deploy time, in front of someone who just clicked Deploy.
      if (p.serverId && !ids.has(p.serverId)) {
        errors.push(`projects[${i}] (${p.key || i}) targets unknown server "${p.serverId}"`)
      }
    })
  }
  return errors
}
