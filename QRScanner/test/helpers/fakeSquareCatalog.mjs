// A tiny fake Square catalog for the Showtimes tests: records what each call
// did to the item, its showtime list and its showtimes, so tests can check
// that Square and IndieTix end up agreeing. Installed over the test server's
// mock Square handlers; returns the state object ({ objects, calls, failNext }).
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status) => ({ ok: false, status, json: async () => ({ errors: [{ code: 'X' }] }), text: async () => `Square ${status}` });

export function installFakeCatalog(squareHandlers) {
  const square = { objects: new Map(), calls: [], nextModifier: 0, failNext: null };
  const original = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => {
    const obj = body.object;
    square.calls.push({ op: 'upsert', type: obj.type, object: obj });
    if (square.failNext === 'upsert') { square.failNext = null; return fail(500); }
    if (obj.type === 'ITEM' && obj.id === '#movie_item') { // Add Movie
      const response = await original(body);
      const data = await response.json();
      square.objects.set(data.catalog_object.id, { ...data.catalog_object, version: 1 });
      return ok(data);
    }
    if (obj.type === 'MODIFIER_LIST' && obj.id.startsWith('#')) {
      const response = await original(body);
      const data = await response.json();
      square.objects.set(data.catalog_object.id, { ...data.catalog_object, version: 1 });
      for (const m of data.catalog_object.modifier_list_data.modifiers) square.objects.set(m.id, { ...m, version: 1 });
      return ok(data);
    }
    if (obj.type === 'MODIFIER' && obj.id.startsWith('#')) {
      const id = `NEW_MOD_${square.nextModifier++}`;
      const created = { ...obj, id, version: 1 };
      square.objects.set(id, created);
      const list = square.objects.get(obj.modifier_data.modifier_list_id);
      list.modifier_list_data.modifiers.push(created);
      return ok({ catalog_object: created });
    }
    if (String(obj.id).startsWith('#')) return original(body); // anything else new (custom attributes, categories)
    const existing = square.objects.get(obj.id);
    if (!existing) return fail(404);
    if (obj.version !== existing.version) return fail(409);
    const updated = { ...obj, version: existing.version + 1 };
    square.objects.set(obj.id, updated);
    return ok({ catalog_object: updated });
  };
  squareHandlers.getCatalogObject = async (id) => {
    square.calls.push({ op: 'get', id });
    const obj = square.objects.get(id);
    return obj ? ok({ object: obj }) : fail(404);
  };
  squareHandlers.deleteCatalogObject = async (id) => {
    square.calls.push({ op: 'delete', id });
    if (square.failNext === 'delete') { square.failNext = null; return fail(500); }
    if (!square.objects.has(id)) return fail(404);
    square.objects.delete(id);
    for (const obj of square.objects.values()) {
      if (obj.modifier_list_data) obj.modifier_list_data.modifiers = obj.modifier_list_data.modifiers.filter((m) => m.id !== id);
    }
    return ok({ deleted_object_ids: [id] });
  };
  return square;
}
