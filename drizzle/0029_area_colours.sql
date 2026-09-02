-- Give every area that predates the colour picker one of the spread palette
-- colours, in creation order per owner — the same cycle `saveCircuit` now hands
-- to a new one. Without this an existing lattice keeps falling back to a hue
-- derived from the area's id, and derived hues clump: with five areas two land
-- within 25 degrees of each other about 84% of the time.
UPDATE `cortex_circuits` SET `colour` = (
	SELECT CASE (ranked.rn - 1) % 12
		WHEN 0 THEN '#d06c6c' WHEN 1 THEN '#6cd0d0' WHEN 2 THEN '#d0d06c'
		WHEN 3 THEN '#6c6cd0' WHEN 4 THEN '#6cd06c' WHEN 5 THEN '#d06cd0'
		WHEN 6 THEN '#d09e6c' WHEN 7 THEN '#6c9ed0' WHEN 8 THEN '#9ed06c'
		WHEN 9 THEN '#9e6cd0' WHEN 10 THEN '#6cd09e' ELSE '#d06c9e'
	END
	FROM (
		SELECT `id`, ROW_NUMBER() OVER (
			PARTITION BY COALESCE(`owner_id`, '') ORDER BY `created_at`, `id`
		) AS rn
		FROM `cortex_circuits`
	) AS ranked
	WHERE ranked.`id` = `cortex_circuits`.`id`
)
WHERE `colour` = '';
