/** Reads one text field from a form POST, with a size cap. null if missing or too big. */
export async function formText(request: Request, field: string, maxBytes = 8192) {
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > maxBytes) return null;
	try {
		const value = (await request.formData()).get(field);
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}
