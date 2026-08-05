export async function activate(apollo) {
  return apollo.tools.register({
    name: 'plugin:apollo-plugin-community-example:community.echo',
    description: 'Returns a local string without filesystem or network access.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
    },
    async handler(input) {
      return { content: [{ type: 'text', text: String(input?.text ?? '') }] }
    },
  })
}
