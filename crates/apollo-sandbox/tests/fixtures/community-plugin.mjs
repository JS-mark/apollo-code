export async function activate(apollo) {
  await apollo.tools.register({
    name: 'community.echo',
    description: 'sandbox E2E',
    invoke(input) {
      return { text: String(input?.text ?? '') }
    },
  })
}
