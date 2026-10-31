-- Backward-compatible view: pins to today's Chicago calendar date.
-- All real logic lives in bdor_for_date().
CREATE OR REPLACE VIEW public.bdor AS
SELECT *
FROM public.bdor_for_date(
    ((now() AT TIME ZONE 'America/Chicago')::date)
);
