CREATE OR REPLACE FUNCTION public.bdor_for_date(p_report_date date)
RETURNS TABLE(
    "TheatreID"    integer,
    "Theatre Name" text,
    "Film Code"    text,
    "Screen"       text,
    "Title"        character varying,
    "Distributor"  character varying,
    "Showtime"     text,
    "Ticket Type"  character varying,
    "Gross"        numeric,
    "Net"          numeric,
    "Tax"          numeric,
    "Sold"         integer,
    "Refunded"     integer,
    "Open"         integer,
    "Close"        integer
)
LANGUAGE sql STABLE
AS $function$
    -- Reports every ticket whose SHOWTIME (ProductDate) falls on the given
    -- Chicago calendar date, regardless of when it was purchased.
    --
    -- Note: ProductDate is timestamp without time zone, and its values
    -- represent Chicago wall-clock time by convention. No timezone
    -- conversion is applied here.
    --
    -- Refund rule: by business policy refunds never happen after showtime,
    -- so at report time every ticket for the report date is in its final
    -- state. Refunded tickets are reported with gross=0, net=0, tax=0,
    -- sold=0, refunded=1.
    --
    -- Transferred (old, superseded row from a ticket transfer) and
    -- cancelled (whole-order cancellation) tickets are both zeroed out the
    -- same way, but NOT counted as refunded=1 -- neither is necessarily a
    -- refund, they just contribute nothing to the report.
    --
    -- Gross is tax-inclusive (the price the customer paid).
    -- Net is tax-exclusive (Gross / 1.093).
    -- Tax = Gross - Net.
    SELECT
        69938 AS "TheatreID",
        'Liberty Hall Cinema'::text AS "Theatre Name",
        'LH'::text || substring(md5("ProductName"::text), 1, 6) AS "Film Code",
        CASE
            WHEN "ProductVenue"::text ILIKE '%little%' THEN '2'::text
            ELSE '1'::text
        END AS "Screen",
        "ProductName" AS "Title",
        "Distributor",
        to_char("ProductDate", 'YYYYMMDDHH24MI') AS "Showtime",
        "ProductSeatCode" AS "Ticket Type",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice", 2)
        END AS "Gross",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice" / 1.093, 2)
        END AS "Net",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice", 2) - round("ProductPrice" / 1.093, 2)
        END AS "Tax",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0
            WHEN "ProductPrice" > 0::numeric THEN 1
            ELSE 0
        END AS "Sold",
        CASE
            WHEN "Status"::text = 'refunded' THEN 1
            ELSE 0
        END AS "Refunded",
        0 AS "Open",
        1 AS "Close"
    FROM "QRCodeProduct"
    WHERE "ProductType"::text = 'Movie'
      AND "ProductDate" IS NOT NULL
      AND "ProductDate"::date = p_report_date;
$function$;
