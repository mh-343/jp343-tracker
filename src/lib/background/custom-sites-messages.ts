import type { ExtensionMessage } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { getCustomSitesState, addCustomSite, removeCustomSite } from './custom-sites';
import { reinjectCustomSitesTabs } from './reinject';

export async function handleCustomSitesMessage(
  message: ExtensionMessage,
  ctx: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'CUSTOM_SITES_GET':
      return { success: true, data: { customSites: await getCustomSitesState() } };
    case 'CUSTOM_SITE_ADD': {
      const result = await addCustomSite(message.host);
      if (!result.ok) return { success: false, error: result.error };
      await reinjectCustomSitesTabs(ctx.log);
      return { success: true, data: { site: result.site, customSites: await getCustomSitesState() } };
    }
    case 'CUSTOM_SITE_REMOVE':
      await removeCustomSite(message.id);
      return { success: true, data: { customSites: await getCustomSitesState() } };
    default:
      return { success: false, error: 'Unknown custom sites message' };
  }
}
