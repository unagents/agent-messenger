import { addServerImports, addServerPlugin, createResolver, defineNuxtModule, hasNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  /** Peer name shown in `peers`. Empty = `AGENT_MESSENGER_NAME` env or the library default. */
  name: string
  /** Peer summary. */
  summary: string
  /** Broker URLs tried first. Empty = config file, discovery, then the local broker. */
  brokers: string[]
  /** Spawn a local broker when none is reachable. Default off. */
  autoStartBroker: boolean
}

const TOOLKIT = '@nuxtjs/mcp-toolkit'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@agent-hand/messenger-nuxt',
    configKey: 'messenger',
    compatibility: { nuxt: '>=4.0.0' },
  },
  defaults: {
    name: '',
    summary: '',
    brokers: [],
    autoStartBroker: false,
  },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    // Per-key merge (no defu: it concatenates arrays). An existing runtimeConfig value wins.
    const rc = (nuxt.options.runtimeConfig.messenger ?? {}) as Partial<ModuleOptions>
    nuxt.options.runtimeConfig.messenger = {
      name: rc.name ?? options.name,
      summary: rc.summary ?? options.summary,
      brokers: rc.brokers ?? options.brokers,
      autoStartBroker: rc.autoStartBroker ?? options.autoStartBroker,
    }

    addServerPlugin(resolve('./runtime/server/plugins/messenger'))
    addServerImports([{ name: 'useMessenger', from: resolve('./runtime/server/utils/useMessenger') }])
    addServerImports([{ name: 'MessengerApi', from: resolve('./runtime/server/utils/useMessenger'), type: true }])

    // The toolkit adapter (and therefore zod / the toolkit import) is only bundled when the toolkit is a module of the app.
    if (hasNuxtModule(TOOLKIT, nuxt)) {
      addServerPlugin(resolve('./runtime/server/plugins/mcp-tools'))
    }

    const typesPath = resolve('./runtime/types/nuxt.d.ts')
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ path: typesPath })
    })
    nuxt.hook('nitro:prepare:types', ({ references }) => {
      references.push({ path: typesPath })
    })
  },
})
