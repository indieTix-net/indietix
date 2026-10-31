import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItemsByCustomAttribute } from '../src/index.mjs';

function itemWithAttribute({ id, name, attrName = 'UseQRCode', archived = false, hasModifierList = true, atVariationLevel = false }) {
  const attrValue = { name: attrName, type: 'BOOLEAN', boolean_value: true };
  const itemLevelAttrs = atVariationLevel ? {} : { 'attr-1': attrValue };
  const variationAttrs = atVariationLevel ? { 'attr-1': attrValue } : {};

  return {
    type: 'ITEM',
    id,
    custom_attribute_values: itemLevelAttrs,
    item_data: {
      name,
      is_archived: archived,
      modifier_list_info: hasModifierList ? [{ modifier_list_id: `${id}-modlist` }] : [],
      variations: [
        { id: `${id}-var`, custom_attribute_values: variationAttrs }
      ]
    }
  };
}

test('filterItemsByCustomAttribute: finds an item with the target attribute set at the item level', () => {
  const data = { objects: [itemWithAttribute({ id: 'item-1', name: 'Movie A' })] };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'item-1');
  assert.deepEqual([...result.modifierLists], ['item-1-modlist']);
});

test('filterItemsByCustomAttribute: finds the attribute at the VARIATION level when absent at the item level', () => {
  const data = { objects: [itemWithAttribute({ id: 'item-2', name: 'Movie B', atVariationLevel: true })] };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'item-2');
});

test('REGRESSION: filterItemsByCustomAttribute skips already-archived items entirely', () => {
  // Documented real bug: Square's Catalog Search API still
  // returns archived items by default. Without this skip, an already-
  // archived item gets re-examined and its modifier list re-deleted on
  // every single run, forever.
  const data = { objects: [itemWithAttribute({ id: 'item-3', name: 'Old Movie', archived: true })] };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 0);
  assert.equal(result.modifierLists.size, 0);
});

test('filterItemsByCustomAttribute: an item with the attribute but an EMPTY modifier_list_info array is still included (as an item), just contributes no modifier lists to process', () => {
  // The real check is `catalogObject.item_data.modifier_list_info` truthiness,
  // not "has at least one entry" -- an empty array is truthy in JS, so the
  // item itself is still collected, it just never adds anything to the
  // modifierLists Set (nothing to iterate). Documenting actual behavior
  // rather than what the field name might suggest.
  const data = { objects: [itemWithAttribute({ id: 'item-4', name: 'Movie C', hasModifierList: false })] };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.equal(result.modifierLists.size, 0);
});

test('filterItemsByCustomAttribute: an item without the target attribute at all is excluded', () => {
  const data = {
    objects: [{
      type: 'ITEM',
      id: 'item-5',
      item_data: { name: 'Unrelated Item', is_archived: false, modifier_list_info: [{ modifier_list_id: 'x' }], variations: [] }
    }]
  };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 0);
});

test('filterItemsByCustomAttribute: a boolean_value of false does not count as having the attribute', () => {
  const item = itemWithAttribute({ id: 'item-6', name: 'Movie D' });
  item.custom_attribute_values['attr-1'].boolean_value = false;
  const result = filterItemsByCustomAttribute({ objects: [item] }, 'UseQRCode', 'true');
  assert.equal(result.items.length, 0);
});

test('filterItemsByCustomAttribute: non-ITEM catalog objects (e.g. CATEGORY, MODIFIER_LIST) are ignored', () => {
  const data = {
    objects: [
      { type: 'CATEGORY', id: 'cat-1', category_data: { name: 'Cinema' } },
      itemWithAttribute({ id: 'item-7', name: 'Movie E' })
    ]
  };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'item-7');
});

test('filterItemsByCustomAttribute: multiple matching items collecting modifier lists dedupes via the Set', () => {
  const data = {
    objects: [
      itemWithAttribute({ id: 'item-8', name: 'Movie F' }),
      itemWithAttribute({ id: 'item-9', name: 'Movie G' })
    ]
  };
  // Force both items onto the SAME modifier list, matching the real-world
  // case of two showtimes sharing one "Show Times" modifier list.
  data.objects[1].item_data.modifier_list_info = [{ modifier_list_id: 'item-8-modlist' }];

  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 2);
  assert.equal(result.modifierLists.size, 1, 'the shared modifier list should only appear once');
});

test('filterItemsByCustomAttribute: an empty/missing objects array returns empty results, not an error', () => {
  assert.deepEqual(filterItemsByCustomAttribute({}, 'UseQRCode', 'true'), { items: [], modifierLists: new Set() });
  assert.deepEqual(filterItemsByCustomAttribute({ objects: [] }, 'UseQRCode', 'true'), { items: [], modifierLists: new Set() });
});
