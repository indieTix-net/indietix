SELECT * FROM get_bdor_grouped_for_date('69938', 'Liberty Hall Cinema', '2026-05-21'::date);

SELECT count(*) FROM get_bdor_grouped_for_date('69938', 'Liberty Hall Cinema', '2026-05-21'::date);

SELECT sum("Gross") AS gross, sum("Sold") AS sold, sum("Refunded") AS refunded
FROM get_bdor_grouped_for_date('69938', 'Liberty Hall Cinema', '2026-05-21'::date);

SELECT * FROM bdor_for_date('2026-05-21'::date);
