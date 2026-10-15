import type { DefaultTheme } from 'vitepress';

/** A linked page or recursive folder in a navigation menu. */
export interface MenuItem {
    category?: string;
    description?: string;
    icon?: string;
    items?: MenuItem[];
    link?: string;
    text: string;
    type?: 'link' | 'card' | 'spotlight';
}

/** A linked documentation page shown as a menu card. */
export interface MenuCard extends MenuItem {
    description: string;
    link: string;
}

/** A group of menu cards shown under a navigation heading. */
export interface MenuSection {
    description?: string;
    gridArea?: string;
    items: MenuItem[];
    link?: string;
    text: string;
}

/** A top-level desktop and mobile navigation menu. */
export interface MegaMenu {
    description: string;
    featured?: MenuCard;
    hierarchical?: boolean;
    link?: string;
    overview?: MenuCard;
    sections: MenuSection[];
    text: string;
}

/** VitePress theme settings with the custom mega menu navigation data. */
export type ThemeConfigWithMegaMenus = DefaultTheme.Config & { megaMenus: MegaMenu[] };
