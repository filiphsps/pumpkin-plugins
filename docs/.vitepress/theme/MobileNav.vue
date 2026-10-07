<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: `withBase` is referenced by the Vue template.
import { useData, withBase } from 'vitepress';
import { computed } from 'vue';

interface MenuCard {
    text: string;
    description: string;
    link: string;
    icon?: string;
    type?: 'link' | 'card' | 'spotlight';
}

interface MenuSection {
    text: string;
    items: MenuCard[];
    gridArea?: string;
}

interface MegaMenu {
    text: string;
    description: string;
    overview?: MenuCard;
    sections: MenuSection[];
    featured?: MenuCard;
}

interface ThemeConfigWithMegaMenus {
    megaMenus?: MegaMenu[];
}

const { theme } = useData();
// biome-ignore lint/correctness/noUnusedVariables: The Vue template renders the navigation groups.
const menus = computed(() => (theme.value as ThemeConfigWithMegaMenus).megaMenus ?? []);
</script>

<template>
    <nav v-if="menus.length" class="site-mobile-nav" aria-label="Main navigation">
        <details v-for="menu in menus" :key="menu.text" class="site-mobile-nav__group">
            <summary class="site-mobile-nav__summary">{{ menu.text }}</summary>
            <div class="site-mobile-nav__content" :class="`site-mobile-nav__content--${menu.text.toLowerCase()}`">
                <p class="site-mobile-nav__description">{{ menu.description }}</p>
                <a
                    v-if="menu.overview"
                    class="site-mobile-nav__overview"
                    :href="withBase(menu.overview.link)"
                >
                    {{ menu.overview.text }}
                </a>
                <a
                    v-if="menu.featured"
                    class="site-mobile-nav__featured"
                    :class="`site-mobile-nav__featured--${menu.featured.type ?? 'card'}`"
                    :href="withBase(menu.featured.link)"
                >
                    <span class="site-mobile-nav__featured-heading">
                        <img
                            v-if="menu.featured.icon"
                            class="site-mobile-nav__icon"
                            :src="withBase(menu.featured.icon)"
                            alt=""
                            aria-hidden="true"
                        >
                        <span class="site-mobile-nav__link-title">{{ menu.featured.text }}</span>
                    </span>
                    <span class="site-mobile-nav__link-description">{{ menu.featured.description }}</span>
                    <span class="site-mobile-nav__link-action">Read the plugin guide</span>
                </a>
                <section
                    v-for="section in menu.sections"
                    :key="section.text"
                    class="site-mobile-nav__section"
                    :class="section.gridArea ? `site-mobile-nav__section--${section.gridArea}` : ''"
                >
                    <h2>{{ section.text }}</h2>
                    <a
                        v-for="item in section.items"
                        :key="item.link"
                        class="site-mobile-nav__link"
                        :class="[
                            `site-mobile-nav__link--${item.type ?? 'link'}`,
                            { 'has-icon': item.icon }
                        ]"
                        :href="withBase(item.link)"
                    >
                        <img
                            v-if="item.icon"
                            class="site-mobile-nav__icon"
                            :src="withBase(item.icon)"
                            alt=""
                            aria-hidden="true"
                        >
                        <span class="site-mobile-nav__link-copy">
                            <span class="site-mobile-nav__link-title">{{ item.text }}</span>
                            <span v-if="item.description" class="site-mobile-nav__link-description">
                                {{ item.description }}
                            </span>
                            <span v-if="item.type === 'card'" class="site-mobile-nav__link-action">
                                Open documentation
                            </span>
                        </span>
                    </a>
                </section>
            </div>
        </details>
    </nav>
</template>
