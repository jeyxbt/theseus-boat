/**
 * Shared data for features the AI builds. The AI declares a collection in
 * src/collections/<name>.json; the core checks the declaration, then checks
 * every record against it. The global limits here hold whatever a declaration
 * says, and the AI can't change them.
 */
import { STORE_ITEM_MAX_BYTES } from '../db/schema';
import { cleanText } from '../http/api';
import { moderate } from '../ideas/moderation';

export const STORE_LIMITS = {
	collections: 50,
	fields: 12,
	itemsPerCollection: 10_000,
	/** Per person, across every collection. */
	writesPerHour: 60,
	perUserPerDayDefault: 50,
	perUserPerDayMax: 500,
	textMax: 500,
	enumValues: 50,
	enumValueMax: 40,
	intAbsMax: 1_000_000_000,
	itemBytes: STORE_ITEM_MAX_BYTES,
	listMax: 1000,
};

export const MODES = ['append', 'upsert-by-key', 'one-per-user'] as const;
export type CollectionMode = (typeof MODES)[number];

export type FieldSpec =
	| { type: 'text'; max: number; min: number; optional: boolean }
	| { type: 'int'; min: number; max: number; optional: boolean }
	| { type: 'bool'; optional: boolean }
	| { type: 'enum'; values: string[]; optional: boolean }
	| { type: 'color'; optional: boolean };

export type Collection = {
	name: string;
	mode: CollectionMode;
	fields: Record<string, FieldSpec>;
	perUserPerDay: number;
};

export const COLLECTION_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
/** A key names a slot in an upsert-by-key collection, like a canvas cell "12:7". */
export const KEY_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string, problems: string[]) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${where}: unknown setting "${key}"`);
}

function parseField(name: string, raw: unknown, problems: string[]): FieldSpec | null {
	const where = `field "${name}"`;
	if (!isObject(raw)) {
		problems.push(`${where} must be an object like {"type": "text", "max": 140}`);
		return null;
	}
	if (raw.optional !== undefined && typeof raw.optional !== 'boolean') problems.push(`${where}: "optional" must be true or false`);
	const optional = raw.optional === true;
	const { intAbsMax } = STORE_LIMITS;

	switch (raw.type) {
		case 'text': {
			unknownKeys(raw, ['type', 'max', 'min', 'optional'], where, problems);
			if (!isInt(raw.max, 1, STORE_LIMITS.textMax)) {
				problems.push(`${where}: text needs "max" from 1 to ${STORE_LIMITS.textMax}`);
				return null;
			}
			const min = raw.min === undefined ? 1 : raw.min;
			if (!isInt(min, 0, raw.max)) {
				problems.push(`${where}: "min" must be from 0 to its "max"`);
				return null;
			}
			return { type: 'text', max: raw.max, min, optional };
		}
		case 'int': {
			unknownKeys(raw, ['type', 'min', 'max', 'optional'], where, problems);
			if (!isInt(raw.min, -intAbsMax, intAbsMax) || !isInt(raw.max, -intAbsMax, intAbsMax) || raw.min > raw.max) {
				problems.push(`${where}: int needs whole numbers "min" ≤ "max", within ±${intAbsMax}`);
				return null;
			}
			return { type: 'int', min: raw.min, max: raw.max, optional };
		}
		case 'bool':
			unknownKeys(raw, ['type', 'optional'], where, problems);
			return { type: 'bool', optional };
		case 'color':
			unknownKeys(raw, ['type', 'optional'], where, problems);
			return { type: 'color', optional };
		case 'enum': {
			unknownKeys(raw, ['type', 'values', 'optional'], where, problems);
			const values = raw.values;
			const valid =
				Array.isArray(values) &&
				values.length >= 1 &&
				values.length <= STORE_LIMITS.enumValues &&
				values.every((v) => typeof v === 'string' && v.length >= 1 && v.length <= STORE_LIMITS.enumValueMax) &&
				new Set(values).size === values.length;
			if (!valid) {
				problems.push(
					`${where}: enum needs "values", 1 to ${STORE_LIMITS.enumValues} different strings of 1 to ${STORE_LIMITS.enumValueMax} characters`,
				);
				return null;
			}
			return { type: 'enum', values: values as string[], optional };
		}
		default:
			problems.push(`${where}: "type" must be text, int, bool, enum or color`);
			return null;
	}
}

/** Checks a declaration. `fileName` is the file's name without .json; the collection's name must match it. */
export function parseCollection(fileName: string, raw: unknown): { ok: true; collection: Collection } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	if (!isObject(raw)) return { ok: false, problems: ['a collection must be a JSON object'] };
	unknownKeys(raw, ['name', 'description', 'mode', 'write', 'fields', 'perUserPerDay'], 'collection', problems);

	if (typeof raw.name !== 'string' || !COLLECTION_NAME.test(raw.name)) {
		problems.push('"name" must be 2 to 32 lowercase letters, digits or dashes, starting with a letter');
	} else if (raw.name !== fileName) {
		problems.push(`"name" is "${raw.name}" but the file is ${fileName}.json: they must match`);
	}
	if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 200)) {
		problems.push('"description" must be text up to 200 characters');
	}
	if (!MODES.includes(raw.mode as CollectionMode)) problems.push(`"mode" must be one of ${MODES.join(', ')}`);
	// Writing always needs a signed-in visitor; the setting exists only to say so.
	if (raw.write !== undefined && raw.write !== 'signed-in') problems.push('"write" can only be "signed-in"');

	const perUserPerDay = raw.perUserPerDay === undefined ? STORE_LIMITS.perUserPerDayDefault : raw.perUserPerDay;
	if (!isInt(perUserPerDay, 1, STORE_LIMITS.perUserPerDayMax)) {
		problems.push(`"perUserPerDay" must be from 1 to ${STORE_LIMITS.perUserPerDayMax}`);
	}

	const fields: Record<string, FieldSpec> = {};
	if (!isObject(raw.fields)) {
		problems.push('"fields" must be an object of field name → field');
	} else {
		const entries = Object.entries(raw.fields);
		if (entries.length < 1 || entries.length > STORE_LIMITS.fields) problems.push(`a collection has 1 to ${STORE_LIMITS.fields} fields`);
		for (const [name, spec] of entries) {
			if (!FIELD_NAME.test(name)) {
				problems.push(`field name "${name}" must start with a lowercase letter and use only letters, digits and _`);
				continue;
			}
			const field = parseField(name, spec, problems);
			if (field) fields[name] = field;
		}
	}

	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		collection: { name: raw.name as string, mode: raw.mode as CollectionMode, fields, perUserPerDay: perUserPerDay as number },
	};
}

export type RecordProblem = { ok: false; error: 'invalid' | 'refused'; field?: string; message: string };

/**
 * Checks a visitor's record against its collection: only declared fields, the
 * right types, clean single-line text that passes the same rules as ideas.
 * Returns the record as it will be stored.
 */
export function validateRecord(collection: Collection, raw: unknown): { ok: true; data: Record<string, unknown> } | RecordProblem {
	if (!isObject(raw)) return { ok: false, error: 'invalid', message: 'Send the record as an object of fields.' };
	for (const key of Object.keys(raw)) {
		if (!(key in collection.fields)) return { ok: false, error: 'invalid', field: key, message: `“${key}” isn’t a field here.` };
	}

	const data: Record<string, unknown> = {};
	for (const [name, field] of Object.entries(collection.fields)) {
		const value = raw[name];
		if (value === undefined || value === null) {
			if (field.optional) continue;
			return { ok: false, error: 'invalid', field: name, message: `“${name}” is missing.` };
		}
		switch (field.type) {
			case 'text': {
				const text = cleanText(value, field.max, { min: Math.max(field.min, 1) });
				if (text === null) {
					if (typeof value === 'string' && value.trim() === '' && field.min === 0) {
						data[name] = '';
						break;
					}
					return { ok: false, error: 'invalid', field: name, message: `“${name}” needs ${field.min || 1} to ${field.max} characters.` };
				}
				const verdict = moderate(text);
				if (!verdict.ok) {
					return {
						ok: false,
						error: 'refused',
						field: name,
						message: verdict.reason === 'spam' ? 'No links or long runs of one character.' : 'That text isn’t allowed on this site.',
					};
				}
				data[name] = text;
				break;
			}
			case 'int':
				if (!isInt(value, field.min, field.max)) {
					return { ok: false, error: 'invalid', field: name, message: `“${name}” must be a whole number from ${field.min} to ${field.max}.` };
				}
				data[name] = value;
				break;
			case 'bool':
				if (typeof value !== 'boolean') return { ok: false, error: 'invalid', field: name, message: `“${name}” must be true or false.` };
				data[name] = value;
				break;
			case 'enum':
				if (typeof value !== 'string' || !field.values.includes(value)) {
					return { ok: false, error: 'invalid', field: name, message: `“${name}” must be one of: ${field.values.join(', ')}.` };
				}
				data[name] = value;
				break;
			case 'color':
				if (typeof value !== 'string' || !COLOR.test(value)) {
					return { ok: false, error: 'invalid', field: name, message: `“${name}” must be a colour like #ff5b1f.` };
				}
				data[name] = value.toLowerCase();
				break;
		}
	}

	if (new TextEncoder().encode(JSON.stringify(data)).length > STORE_LIMITS.itemBytes) {
		return { ok: false, error: 'invalid', message: 'That record is too big.' };
	}
	return { ok: true, data };
}
