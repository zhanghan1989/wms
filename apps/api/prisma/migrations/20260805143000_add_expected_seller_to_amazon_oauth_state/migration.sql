ALTER TABLE `amazon_sp_api_oauth_states`
  ADD COLUMN `expected_seller_id` VARCHAR(64) NULL;

CREATE INDEX `amazon_sp_api_oauth_states_expected_seller_id_idx`
  ON `amazon_sp_api_oauth_states` (`expected_seller_id`);
