import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItemsByCustomAttribute } from '../src/index.mjs';

function itemWithAttribute({ id, name, archived = false, hasModifierList = true, atVariationLevel = false }) {
  const attrValue = { name: 'UseQRCode', type: 'BOOLEAN', boolean_value: true };
  return {
    type: 'ITEM',
    id,
    custom_attribute_values: atVariationLevel ? {} : { attr1: attrValue },
    item_data: {
      name,
      is_archived: archived,
      modifier_list_info: hasModifierList ? [{ modifier_list_id: `${id}-modlist` }] : [],
      variations: [{ id: `${id}-var`, custom_attribute_values: atVariationLevel ? { attr1: attrValue } : {} }]
    }
  };
}

test('filterItemsByCustomAttribute: finds an item with the attribute at the item level', () => {
  const result = filterItemsByCustomAttribute({ objects: [itemWithAttribute({ id: 'item-1', name: 'Movie A' })] }, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.deepEqual([...result.modifierLists], ['item-1-modlist']);
});

test('filterItemsByCustomAttribute: finds the attribute at the variation level', () => {
  const result = filterItemsByCustomAttribute({ objects: [itemWithAttribute({ id: 'item-2', name: 'Movie B', atVariationLevel: true })] }, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
});

test('REGRESSION: already-archived items are skipped entirely, including their modifier lists', () => {
  // Same documented bug class as expireQRCodeSquareModifiers and
  // QRScanner's marketing item search -- an archived item can even
  // surface another item's showtimes under its own stale title if they
  // share a modifier list, confirmed live.
  const result = filterItemsByCustomAttribute({ objects: [itemWithAttribute({ id: 'item-3', name: 'Old Movie', archived: true })] }, 'UseQRCode', 'true');
  assert.equal(result.items.length, 0);
  assert.equal(result.modifierLists.size, 0);
});

test('filterItemsByCustomAttribute: non-ITEM objects are ignored', () => {
  const data = { objects: [{ type: 'CATEGORY', id: 'cat-1' }, itemWithAttribute({ id: 'item-4', name: 'Movie C' })] };
  const result = filterItemsByCustomAttribute(data, 'UseQRCode', 'true');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'item-4');
});

test('filterItemsByCustomAttribute: an empty/missing objects array is handled without error', () => {
  assert.deepEqual(filterItemsByCustomAttribute({}, 'UseQRCode', 'true'), { items: [], modifierLists: new Set() });
});
