// utils/data-filter-utils.mjs

/**
 * Tickets store "ProductType" as 'Movie' or 'Live', but User Management's
 * filter dropdown used to save the cinema option as 'cinema', which matched
 * nothing. Map that old value so filters already saved that way work.
 */
export function normalizeEventType(eventType) {
  return String(eventType).toLowerCase() === 'cinema' ? 'Movie' : eventType;
}

/**
 * ILIKE patterns for the two event-name filters: `event` (the whole name,
 * capitals ignored) and `eventContains` (any part of it). %, _ and \ in a
 * name are escaped so they match literally instead of acting as wildcards.
 */
const escapeLike = (value) => String(value).replace(/[\\%_]/g, '\\$&');
export const eventExactPattern = (value) => escapeLike(value);
export const eventContainsPattern = (value) => `%${escapeLike(value)}%`;

/**
 * Builds a SQL WHERE clause from user's data filters
 * @param {object} dataFilter - The user's dataFilter JSON object
 * @param {number} startParamIndex - Starting parameter index (defaults to 1)
 * @returns {object} - { whereClause: string, params: array }
 */
export function buildDataFilterWhereClause(dataFilter, startParamIndex = 1) {
  // If no filters or empty filters, return no restriction
  if (!dataFilter || !dataFilter.datafilters || dataFilter.datafilters.length === 0) {
    return { whereClause: '', params: [] };
  }
  
  const filters = dataFilter.datafilters;
  const orClauses = [];
  const params = [];
  let paramIndex = startParamIndex;
  
  console.log(`[buildDataFilterWhereClause] Starting with paramIndex: ${paramIndex}`);
  
  // Build OR clauses for each filter object
  for (const filter of filters) {
    const andClauses = [];
    
    // Check each property in the filter
    if (filter.date) {
      andClauses.push(`DATE("QRCodeProduct"."ProductDate") = $${paramIndex}`);
      params.push(filter.date);
      console.log(`[buildDataFilterWhereClause] Added date filter at $${paramIndex}: ${filter.date}`);
      paramIndex++;
    }
    
    if (filter.event) {
      // Use ILIKE for case-insensitive comparison
      andClauses.push(`"QRCodeProduct"."ProductName" ILIKE $${paramIndex}`);
      params.push(eventExactPattern(filter.event));
      console.log(`[buildDataFilterWhereClause] Added event filter at $${paramIndex}: ${filter.event}`);
      paramIndex++;
    }
    
    if (filter.eventContains) {
      andClauses.push(`"QRCodeProduct"."ProductName" ILIKE $${paramIndex}`);
      params.push(eventContainsPattern(filter.eventContains));
      paramIndex++;
    }
    
    if (filter.eventType) {
      // Use ILIKE for case-insensitive comparison
      andClauses.push(`"QRCodeProduct"."ProductType" ILIKE $${paramIndex}`);
      params.push(normalizeEventType(filter.eventType));
      console.log(`[buildDataFilterWhereClause] Added eventType filter at $${paramIndex}: ${filter.eventType}`);
      paramIndex++;
    }
    
    // If any AND conditions exist for this filter, add them as an OR clause
    if (andClauses.length > 0) {
      orClauses.push(`(${andClauses.join(' AND ')})`);
    }
  }
  
  // If we have any OR clauses, combine them
  if (orClauses.length > 0) {
    const whereClause = ` AND (${orClauses.join(' OR ')})`;
    console.log(`[buildDataFilterWhereClause] Final whereClause: ${whereClause}`);
    console.log(`[buildDataFilterWhereClause] Final params:`, params);
    return {
      whereClause: whereClause,
      params: params
    };
  }
  
  return { whereClause: '', params: [] };
}

/**
 * Builds Sequelize WHERE conditions from user's data filters
 * @param {object} dataFilter - The user's dataFilter JSON object
 * @returns {object} - Sequelize where conditions or empty object
 */
export function buildSequelizeDataFilter(dataFilter) {
  // If no filters or empty filters, return no restriction
  if (!dataFilter || !dataFilter.datafilters || dataFilter.datafilters.length === 0) {
    return {};
  }
  
  const filters = dataFilter.datafilters;
  const orConditions = [];
  
  // Build OR conditions for each filter object
  for (const filter of filters) {
    const andConditions = {};
    
    // Check each property in the filter
    if (filter.date) {
      andConditions.productDate = filter.date;
    }
    
    if (filter.event) {
      andConditions.name = filter.event;
    }
    
    if (filter.eventType) {
      andConditions.eventType = normalizeEventType(filter.eventType);
    }
    
    // If any conditions exist for this filter, add to OR array
    if (Object.keys(andConditions).length > 0) {
      orConditions.push(andConditions);
    }
  }
  
  // If we have any OR conditions, return them
  if (orConditions.length > 0) {
    return {
      [Symbol.for('Sequelize.or')]: orConditions
    };
  }
  
  return {};
}