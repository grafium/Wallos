-- Reference data every Wallos instance starts with.

INSERT INTO cycles (id, days, name) VALUES
    (1, 1, 'Daily'),
    (2, 7, 'Weekly'),
    (3, 30, 'Monthly'),
    (4, 365, 'Yearly'),
    (5, 0, 'One-time');

INSERT INTO frequencies (id, name) VALUES
    (1, 1),
    (2, 2),
    (3, 3),
    (4, 4),
    (5, 5),
    (6, 6),
    (7, 7),
    (8, 8),
    (9, 9),
    (10, 10),
    (11, 11),
    (12, 12),
    (13, 13),
    (14, 14),
    (15, 15),
    (16, 16),
    (17, 17),
    (18, 18),
    (19, 19),
    (20, 20),
    (21, 21),
    (22, 22),
    (23, 23),
    (24, 24),
    (25, 25),
    (26, 26),
    (27, 27),
    (28, 28),
    (29, 29),
    (30, 30),
    (31, 31);

-- Registrations stay closed until the admin opens them; the very first
-- account is always allowed and becomes the admin.
INSERT INTO admin (id, registrations_open, max_users, require_email_verification, login_disabled, update_notification)
VALUES (1, 0, 0, 0, 0, 0);
