import { SiteContent } from '../types';
import rawSiteContent from '../../data/siteContent.json';

export const DEFAULT_SITE_CONTENT: SiteContent = rawSiteContent as unknown as SiteContent;
