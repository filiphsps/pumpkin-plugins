import type { DefaultTheme } from 'vitepress';

/** A documentation page shown in a navigation menu. */
export interface MenuCard {
    category?: string;
    description: string;
    icon?: string;
    link: string;
    text: string;
    type?: 'link' | 'card' | 'spotlight';
}

/** A group of menu cards shown under a navigation heading. */
export interface MenuSection {
    gridArea?: string;
    items: MenuCard[];
    text: string;
}

/** A top-level desktop and mobile navigation menu. */
export interface MegaMenu {
    description: string;
    featured?: MenuCard;
    link?: string;
    overview?: MenuCard;
    sections: MenuSection[];
    text: string;
}

/** VitePress theme settings with the custom mega menu navigation data. */
export type ThemeConfigWithMegaMenus = DefaultTheme.Config & { megaMenus: MegaMenu[] };
