export async function activate(apollo) {
  return apollo.tools.register({
    name: 'community.echo',
    description: 'Returns a local string without filesystem or network access.',
    async invoke(input) {
      return { content: [{ type: 'text', text: String(input?.text ?? '') }] }
    },
  })
}
