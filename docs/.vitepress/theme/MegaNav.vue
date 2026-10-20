<script setup lang="ts">
    import { useData, useRoute, withBase } from 'vitepress';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import MenuTree from './MenuTree.vue';
    import type { ThemeConfigWithMegaMenus } from './types';

    const root = ref<HTMLElement | null>(null);
    const openMenu = ref<string | null>(null);
    const { theme } = useData<ThemeConfigWithMegaMenus>();
    const route = useRoute();
    const menus = computed(() => theme.value.megaMenus ?? []);
    const activeMenu = computed(() => menus.value.find((menu) => menu.text === openMenu.value) ?? null);
    const menuSections = computed(() =>
        (activeMenu.value?.sections ?? [])
            .map((section) => ({ ...section, items: section.items.filter((item) => item.type !== 'spotlight') }))
            .filter((section) => section.items.length || section.link),
    );
    const spotlightItems = computed(() =>
        (activeMenu.value?.sections ?? []).flatMap((section) =>
            section.items.filter((item) => item.type === 'spotlight'),
        ),
    );

    function focusTrigger(menu: string | null = openMenu.value) {
        const button = [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]') ?? [])].find(
            (element) => element.dataset.menuTrigger === menu,
        );
        button?.focus();
    }

    function closeMenu(restoreFocus = false) {
        const previousMenu = openMenu.value;
        openMenu.value = null;
        if (restoreFocus) requestAnimationFrame(() => focusTrigger(previousMenu));
    }

    function toggleMenu(menu: string) {
        openMenu.value = openMenu.value === menu ? null : menu;
    }

    function onTriggerPointerenter(menu: string, event: PointerEvent) {
        if (event.pointerType === 'mouse') openMenu.value = menu;
    }

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

    function onTriggerKeydown(event: KeyboardEvent) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]') ?? [])];
        // Link menus such as Team are not buttons, so step through the buttons rather than the menu list.
        const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
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
        () => closeMenu(),
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
            <template v-for="(menu, index) in menus" :key="menu.text">
                <a
                    v-if="menu.link"
                    class="site-mega-nav__trigger"
                    :href="withBase(menu.link)"
                    @pointerenter="closeMenu()"
                    >{{
                        menu.text
                    }}</a
                >
                <button
                    v-else
                    class="site-mega-nav__trigger"
                    type="button"
                    :data-menu-trigger="menu.text"
                    :aria-expanded="openMenu === menu.text"
                    :aria-controls="openMenu === menu.text ? `mega-panel-${index}` : undefined"
                    @click="toggleMenu(menu.text)"
                    @pointerenter="onTriggerPointerenter(menu.text, $event)"
                    @keydown="onTriggerKeydown"
                >
                    {{ menu.text }}
                    <span class="site-mega-nav__chevron" aria-hidden="true"></span>
                </button>
            </template>
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
                            v-for="section in menuSections"
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
                            <h2>
                                <a v-if="section.link" :href="withBase(section.link)">{{ section.text }}</a>
                                <span v-else>{{ section.text }}</span>
                            </h2>
                            <p v-if="section.description" class="site-mega-nav__section-description">
                                {{ section.description }}
                            </p>
                            <MenuTree v-if="activeMenu.hierarchical" :items="section.items" variant="desktop" />
                            <div v-else class="site-mega-nav__links">
                                <a
                                    v-for="item in section.items"
                                    :key="item.link ?? item.text"
                                    class="site-mega-nav__link"
                                    :class="[
                                        `site-mega-nav__link--${item.type ?? 'link'}`,
                                        { 'has-icon': item.icon }
                                    ]"
                                    :href="withBase(item.link ?? '/')"
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
                    <div v-if="spotlightItems.length" class="site-mega-nav__spotlights">
                        <a
                            v-for="item in spotlightItems"
                            :key="item.link"
                            class="site-mega-nav__link site-mega-nav__link--spotlight"
                            :class="{ 'has-icon': item.icon }"
                            :href="withBase(item.link ?? '/')"
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
                                <span v-if="item.description" class="site-mega-nav__link-description">{{
                                    item.description
                                }}</span>
                            </span>
                            <span class="site-mega-nav__link-action">Open documentation</span>
                        </a>
                    </div>
                </div>
            </section>
        </Transition>
    </nav>
</template>
