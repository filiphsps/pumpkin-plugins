<script setup lang="ts">
    import { withBase } from 'vitepress';
    import type { MenuItem } from './types';

    defineOptions({ name: 'MenuTree' });

    defineProps<{
        items: MenuItem[];
        variant: 'desktop' | 'mobile';
    }>();
</script>

<template>
    <ul class="site-menu-tree" :class="`site-menu-tree--${variant}`">
        <li v-for="item in items" :key="item.link ?? item.text">
            <div v-if="item.items?.length" class="site-menu-tree__group">
                <a
                    v-if="item.link"
                    class="site-menu-tree__heading site-menu-tree__heading--link"
                    :href="withBase(item.link)"
                >
                    {{ item.text }}
                </a>
                <span v-else class="site-menu-tree__heading">{{ item.text }}</span>
                <span v-if="item.description" class="site-menu-tree__description">{{ item.description }}</span>
                <MenuTree :items="item.items" :variant="variant" />
            </div>
            <a
                v-else-if="item.link"
                :class="[
                    variant === 'desktop' ? 'site-mega-nav__link' : 'site-mobile-nav__link',
                    variant === 'desktop'
                        ? `site-mega-nav__link--${item.type ?? 'link'}`
                        : `site-mobile-nav__link--${item.type ?? 'link'}`,
                    { 'has-icon': item.icon }
                ]"
                :href="withBase(item.link)"
            >
                <img
                    v-if="item.icon"
                    :class="variant === 'desktop' ? 'site-mega-nav__icon' : 'site-mobile-nav__icon'"
                    :src="withBase(item.icon)"
                    alt=""
                    aria-hidden="true"
                >
                <span :class="variant === 'desktop' ? 'site-mega-nav__link-copy' : 'site-mobile-nav__link-copy'">
                    <span
                        :class="variant === 'desktop' ? 'site-mega-nav__link-title' : 'site-mobile-nav__link-title'"
                        >{{
                            item.text
                        }}</span
                    >
                    <span
                        v-if="item.description"
                        :class="variant === 'desktop' ? 'site-mega-nav__link-description' : 'site-mobile-nav__link-description'"
                    >
                        {{ item.description }}
                    </span>
                    <span
                        v-if="item.type === 'card' || item.type === 'spotlight'"
                        :class="variant === 'desktop' ? 'site-mega-nav__link-action' : 'site-mobile-nav__link-action'"
                    >
                        Open documentation
                    </span>
                </span>
            </a>
        </li>
    </ul>
</template>
