import { describe, it, expect } from 'vitest'
import { validateConfig, defaultServers } from '../src/config.js'

const ok = (over = {}) => ({
  servers: [{ id: 'app', host: 'app.example.com', username: 'deploy' }],
  projects: [{ key: 'web', script: 'example-remote-deploy.sh', serverId: 'app' }],
  ...over,
})

describe('validateConfig', () => {
  it('accepts a well-formed config', () => {
    expect(validateConfig(ok())).toEqual([])
  })

  it('rejects a config with no servers', () => {
    expect(validateConfig({ servers: [] })).toContain('config.servers must be a non-empty array')
  })

  it.each(['id', 'host', 'username'])('names a server missing %s', (field) => {
    const c = ok()
    delete c.servers[0][field]
    expect(validateConfig(c).join(' ')).toMatch(new RegExp(`has no ${field}`))
  })

  it('names a project with no deploy script', () => {
    const c = ok()
    delete c.projects[0].script
    expect(validateConfig(c).join(' ')).toMatch(/has no script/)
  })

  it('catches a project pointing at a server that does not exist', () => {
    // Otherwise this surfaces at deploy time, in front of someone who just
    // clicked the button.
    const c = ok()
    c.projects[0].serverId = 'typo'
    expect(validateConfig(c).join(' ')).toMatch(/targets unknown server "typo"/)
  })

  it('reports every problem at once rather than the first', () => {
    const c = { servers: [{ id: 'a' }], projects: [{ key: 'p', serverId: 'nope' }] }
    expect(validateConfig(c).length).toBeGreaterThan(2)
  })

  it('treats a config with no projects as valid', () => {
    // A console used only as an SSH terminal is a legitimate configuration.
    const c = ok(); delete c.projects
    expect(validateConfig(c)).toEqual([])
  })

  it('refuses a non-object', () => {
    expect(validateConfig(null)).toEqual(['config is not an object'])
  })
})

describe('shipped defaults', () => {
  it('name no real host', () => {
    for (const s of defaultServers) {
      expect(s.host).toMatch(/^(127\.0\.0\.1|localhost|[a-z0-9.-]*\.example(\.[a-z]+)?)$/)
    }
  })

  it('do not log in as root', () => {
    // The fleet this replaced connected as root on every host. The placeholder
    // should not teach that back.
    for (const s of defaultServers) expect(s.username).not.toBe('root')
  })
})
