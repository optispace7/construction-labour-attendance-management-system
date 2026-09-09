-- Removes the worker record created to test the gate, which is standing on a
-- real worker's code.
--
-- Both systems have been allocating worker codes independently while the site
-- still scans into Azure, and they collided: Azure gave W-0341 to Akash Dubey
-- on 8 Sep, and the test scan created a second W-0341 in D1 on 9 Sep. The
-- organization_id + worker_code index — correctly — refuses to hold both, so
-- Akash Dubey could not be copied across while the test record sat on his code.
--
-- Its attendance went in 0002. What is left is the row itself and the site
-- assignment the scan created for it; nothing else refers to it — no taps, no
-- sessions, no corrections, no photo.
--
-- The assignment goes first, being the child row.

DELETE FROM worker_site_assignments
 WHERE worker_id = '51e6579a-e392-4869-a5bc-4e6c9bdbd3d6';
--> statement-breakpoint
DELETE FROM workers
 WHERE id = '51e6579a-e392-4869-a5bc-4e6c9bdbd3d6'
   AND full_name = 'test';
