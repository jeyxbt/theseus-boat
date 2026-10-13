/**
 * Which Anthropic workspace a request is for.
 *
 * A key made inside a workspace already belongs to it and needs nothing here.
 * A key that isn't scoped to one (an organization-level key) can act on several,
 * and the API then refuses every request until it is told which: it wants the
 * workspace's ID, like wrkspc_01…, in a header. Set ANTHROPIC_WORKSPACE_ID to
 * send it. The ID names a workspace; it is not a secret.
 */
export function workspaceParam(env: NodeJS.ProcessEnv = process.env): { workspace_id?: string } {
	const id = env.ANTHROPIC_WORKSPACE_ID?.trim();
	return id ? { workspace_id: id } : {};
}
