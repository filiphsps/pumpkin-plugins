<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: `withBase` is referenced by the Vue template.
import { useData, useRoute, withBase } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

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

const root = ref<HTMLElement | null>(null);
const openMenu = ref<string | null>(null);
const { theme } = useData();
const route = useRoute();
const menus = computed(() => (theme.value as ThemeConfigWithMegaMenus).megaMenus ?? []);
// biome-ignore lint/correctness/noUnusedVariables: The Vue template renders the active menu.
const activeMenu = computed(() => menus.value.find((menu) => menu.text === openMenu.value) ?? null);

function focusTrigger(menu: string | null = openMenu.value) {
    const button = [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]') ?? [])].find(
        (element) => element.dataset.menuTrigger === menu
    );
    button?.focus();
}

function closeMenu(restoreFocus = false) {
    const previousMenu = openMenu.value;
    openMenu.value = null;
    if (restoreFocus) requestAnimationFrame(() => focusTrigger(previousMenu));
}

// biome-ignore lint/correctness/noUnusedVariables: The Vue template binds this function to menu buttons.
function toggleMenu(menu: string) {
    openMenu.value = openMenu.value === menu ? null : menu;
}

// biome-ignore lint/correctness/noUnusedVariables: The Vue template binds this pointer handler to menu buttons.
function onTriggerPointerenter(menu: string, event: PointerEvent) {
    if (event.pointerType === 'mouse') openMenu.value = menu;
}

// biome-ignore lint/correctness/noUnusedVariables: The Vue template binds this handler to the navigation root.
function onNavPointerleave(event: PointerEvent) {
    if (event.pointerType === 'mouse') closeMenu();
}

function onPointerDown(event: PointerEvent) {
    if (root.value && event.target instanceof Node && !root.value.contains(event.target)) closeMenu();
}

function onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && openMenu.value) {
        event.preventDefault();
        closeMenu(true);
    }
}

// biome-ignore lint/correctness/noUnusedVariables: The Vue template binds this keyboard handler to menu buttons.
function onTriggerKeydown(event: KeyboardEvent, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]') ?? [])];
    const nextIndex =
        event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
}

onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onDocumentKeydown);
});

watch(
    () => route.path,
    () => closeMenu()
);
</script>

<template>
    <nav
        v-if="menus.length"
        ref="root"
        class="site-mega-nav"
        aria-label="Main navigation"
        @pointerleave="onNavPointerleave"
    >
        <div class="site-mega-nav__triggers">
            <button
                v-for="(menu, index) in menus"
                :key="menu.text"
                class="site-mega-nav__trigger"
                type="button"
                :data-menu-trigger="menu.text"
                :aria-expanded="openMenu === menu.text"
                :aria-controls="`mega-panel-${index}`"
                @click="toggleMenu(menu.text)"
                @pointerenter="onTriggerPointerenter(menu.text, $event)"
                @keydown="onTriggerKeydown($event, index)"
            >
                {{ menu.text }}
                <span class="site-mega-nav__chevron" aria-hidden="true"></span>
            </button>
        </div>

        <Transition name="mega-panel">
            <section
                v-if="activeMenu"
                :id="`mega-panel-${menus.indexOf(activeMenu)}`"
                class="site-mega-nav__panel"
                :aria-label="`${activeMenu.text} links`"
            >
                <header class="site-mega-nav__header">
                    <div>
                        <h2 class="site-mega-nav__title">{{ activeMenu.text }}</h2>
                        <p class="site-mega-nav__intro">{{ activeMenu.description }}</p>
                    </div>
                    <a
                        v-if="activeMenu.overview"
                        class="site-mega-nav__overview"
                        :href="withBase(activeMenu.overview.link)"
                    >
                        {{ activeMenu.overview.text }}
                    </a>
                </header>

                <div
                    class="site-mega-nav__body"
                    :class="[
                        `site-mega-nav__body--${activeMenu.text.toLowerCase()}`,
                        {
                            'has-featured': activeMenu.featured,
                            'has-spotlight': activeMenu.featured?.type === 'spotlight'
                        }
                    ]"
                >
                    <a
                        v-if="activeMenu.featured"
                        class="site-mega-nav__featured"
                        :class="`site-mega-nav__featured--${activeMenu.featured.type ?? 'card'}`"
                        :href="withBase(activeMenu.featured.link)"
                    >
                        <span class="site-mega-nav__featured-heading">
                            <img
                                v-if="activeMenu.featured.icon"
                                class="site-mega-nav__icon"
                                :src="withBase(activeMenu.featured.icon)"
                                alt=""
                                aria-hidden="true"
                            >
                            <span class="site-mega-nav__featured-title">{{ activeMenu.featured.text }}</span>
                        </span>
                        <span class="site-mega-nav__featured-description">{{ activeMenu.featured.description }}</span>
                        <span class="site-mega-nav__featured-action">Read the plugin guide</span>
                    </a>

                    <div class="site-mega-nav__sections">
                        <section
                            v-for="section in activeMenu.sections"
                            :key="section.text"
                            class="site-mega-nav__section"
                            :class="[
                                {
                                    'is-long': section.items.length >= 6 && activeMenu.text !== 'Reference'
                                },
                                section.gridArea ? `site-mega-nav__section--${section.gridArea}` : ''
                            ]"
                            :style="section.gridArea ? { gridArea: section.gridArea } : undefined"
                        >
                            <h2>{{ section.text }}</h2>
                            <div class="site-mega-nav__links">
                                <a
                                    v-for="item in section.items"
                                    :key="item.link"
                                    class="site-mega-nav__link"
                                    :class="[
                                        `site-mega-nav__link--${item.type ?? 'link'}`,
                                        { 'has-icon': item.icon }
                                    ]"
                                    :href="withBase(item.link)"
                                >
                                    <img
                                        v-if="item.icon"
                                        class="site-mega-nav__icon"
                                        :src="withBase(item.icon)"
                                        alt=""
                                        aria-hidden="true"
                                    >
                                    <span class="site-mega-nav__link-copy">
                                        <span class="site-mega-nav__link-title">{{ item.text }}</span>
                                        <span v-if="item.description" class="site-mega-nav__link-description">
                                            {{ item.description }}
                                        </span>
                                        <span v-if="item.type === 'card'" class="site-mega-nav__link-action">
                                            Open documentation
                                        </span>
                                    </span>
                                </a>
                            </div>
                        </section>
                    </div>
                </div>
            </section>
        </Transition>
    </nav>
</template>
