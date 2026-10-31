CREATE OR REPLACE FUNCTION public.get_bdor_grouped_for_date(
    p_theatre_id   character varying,
    p_theatre_name character varying,
    p_report_date  date
)
RETURNS TABLE(
    "TheatreID"    character varying,
    "Theatre Name" character varying,
    "Film Code"    character varying,
    "Screen"       character varying,
    "Title"        character varying,
    "Distributor"  character varying,
    "Showtime"     text,
    "Ticket Type"  character varying,
    "Gross"        numeric,
    "Net"          numeric,
    "Tax"          numeric,
    "Sold"         bigint,
    "Refunded"     bigint,
    "Open"         bigint,
    "Close"        bigint
)
LANGUAGE sql STABLE
AS $function$
    -- Aggregates row-level output of bdor_for_date() by
    -- Title / Ticket Type / Screen / Showtime, applying theatre params.
    -- Column order matches the TDI recipient spec (May 2026 email).
    SELECT
        p_theatre_id   ::character varying AS "TheatreID",
        p_theatre_name ::character varying AS "Theatre Name",
        max(b."Film Code")                 AS "Film Code",
        b."Screen"     ::character varying AS "Screen",
        b."Title"                          AS "Title",
        max(b."Distributor"::text)::character varying AS "Distributor",
        b."Showtime"                       AS "Showtime",
        b."Ticket Type"                    AS "Ticket Type",
        sum(b."Gross")    ::numeric        AS "Gross",
        sum(b."Net")      ::numeric        AS "Net",
        sum(b."Tax")      ::numeric        AS "Tax",
        sum(b."Sold")     ::bigint         AS "Sold",
        sum(b."Refunded") ::bigint         AS "Refunded",
        sum(b."Open")     ::bigint         AS "Open",
        sum(b."Close")    ::bigint         AS "Close"
    FROM public.bdor_for_date(p_report_date) b
    GROUP BY b."Title", b."Ticket Type", b."Screen", b."Showtime"
    ORDER BY b."Title", b."Showtime", b."Ticket Type";
$function$;
