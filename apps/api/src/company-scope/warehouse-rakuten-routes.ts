/** Business operations exposed by the warehouse processing center.
 * Connection credentials, SMTP tests, dashboards and template administration stay excluded.
 */
export function isWarehouseRakutenRoute(method: string, path: string): boolean {
  if (method === 'GET') {
    return /^rakuten-rms-api\/(?:warehouse\/connections|automation\/(?:schedules|import-issues|summary|health|runs|order-workflows|shipping-reports)|mails(?:\/\d+)?|connections\/\d+\/automation\/status)$/.test(path)
      || /^rakuten-rms-api\/connections\/\d+\/inventory(?:\/(?:issues|catalog|runs\/\d+\/changes|jobs\/\d+))?$/.test(path);
  }
  if (method === 'POST') {
    return /^rakuten-rms-api\/(?:processing\/check|automation\/tasks\/prepare|automation\/manual-actions\/execute|automation\/manual-actions\/shipping\/\d+\/(?:ignore|verify-completed)|automation\/manual-actions\/mails\/\d+\/preview|automation\/order-workflows\/\d+\/[^/]+\/missing-mail|mails\/\d+\/(?:retry|cancel|mark-sent|ignore)|connections\/\d+\/automation\/(?:retry|circuits\/(?:shipping|mail)\/reset)|connections\/\d+\/(?:preview|sync|conflicts\/ignore))$/.test(path)
      || /^rakuten-rms-api\/connections\/\d+\/inventory\/(?:check|catalog\/refresh|preview|execute|mappings\/\d+\/disable)$/.test(path);
  }
  return method === 'PUT' && (
    /^rakuten-rms-api\/automation\/schedules\/(?:import|tracking|shipping|inventory|mail)$/.test(path)
    || /^rakuten-rms-api\/connections\/\d+\/inventory\/(?:enabled|mappings)$/.test(path)
  );
}
