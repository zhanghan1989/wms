ALTER TABLE product_edit_requests
  MODIFY status ENUM('pending','confirmed','deleted') NOT NULL DEFAULT 'pending';
