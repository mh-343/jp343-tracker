import type { ExtensionMessage } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { getCustomSitesState, addCustomSite, removeCustomSite, customSiteOrigin } from './custom-sites';
import { applyCustomSiteRename, resetCustomSiteName } from './custom-site-names';
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
    case 'CUSTOM_SITE_REMOVE': {
      const removedHost = await removeCustomSite(message.id);
      if (removedHost) {
        await ctx.finalizeRevokedCustomOrigins([customSiteOrigin(removedHost)]);
      }
      return { success: true, data: { customSites: await getCustomSitesState() } };
    }
    case 'RENAME_CUSTOM_SITE_SERIES': {
      if (!message.projectId.startsWith('ext_generic_cs_')) {
        return { success: false, error: 'Not a custom site series' };
      }
      const videoId = message.projectId.slice('ext_generic_'.length);
      const result = await applyCustomSiteRename(videoId, message.title, {
        saveSessionState: ctx.saveSessionState
      }, { originalLabelHint: message.previousTitle });
      return {
        success: result.ok,
        data: { title: result.title, localOnly: result.localOnly, pendingServerSync: result.pendingServerSync },
        error: result.error
      };
    }
    case 'CUSTOM_SITE_NAME_RESET': {
      if (!message.projectId.startsWith('ext_generic_cs_')) {
        return { success: false, error: 'Not a custom site series' };
      }
      const result = await resetCustomSiteName(message.projectId, { saveSessionState: ctx.saveSessionState });
      return {
        success: result.ok,
        data: { title: result.title, localOnly: result.localOnly, pendingServerSync: result.pendingServerSync },
        error: result.error
      };
    }
    default:
      return { success: false, error: 'Unknown custom sites message' };
  }
}
