<script setup lang="ts">
import CoverContainer from "@/components/globals/CoverContainer.vue";
import { fetchData, postToServer } from "@/utils/api-utils";
import { sendAddToQueue } from "@/utils/downloads";
import { toast } from "@/utils/toasts";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

interface YTMusicTrack {
	videoId: string;
	title: string;
	artists: string[];
	album: string;
	thumbnail: string;
}

interface YTMusicCollection {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string;
	link: string;
}

interface YTMusicLibrary {
	quickPicks: YTMusicTrack[];
	playlists: YTMusicCollection[];
	albums: YTMusicCollection[];
}

const QUICK_PICKS_LINK = "ytmusic:quickpicks";
const LIBRARY_SONGS_LINK = "https://music.youtube.com/library/songs";
const PLACEHOLDER_COVER =
	"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/156x156-000000-80-0-0.jpg";

const { t } = useI18n();

const loggedIn = ref(false);
const accountName = ref("");
const cookie = ref("");
const isLoggingIn = ref(false);
const isLoadingLibrary = ref(false);
const library = ref<YTMusicLibrary | null>(null);

onMounted(async () => {
	const status = await fetchData("ytmusicStatus");
	loggedIn.value = status.loggedIn;
	accountName.value = status.accountName;
});

async function login() {
	isLoggingIn.value = true;
	const result = await postToServer("loginYTMusic", { cookie: cookie.value });
	isLoggingIn.value = false;

	if (!result?.loggedIn) {
		toast(
			t("settings.ytmusic.loginFailed", { error: result?.error ?? "" }),
			"close"
		);
		return;
	}

	cookie.value = "";
	loggedIn.value = true;
	accountName.value = result.accountName;
	toast(t("settings.ytmusic.loggedIn", { name: result.accountName }), "done");
	loadLibrary();
}

async function logout() {
	await postToServer("logoutYTMusic");
	loggedIn.value = false;
	accountName.value = "";
	library.value = null;
}

async function loadLibrary() {
	isLoadingLibrary.value = true;
	const result = await fetchData("getYTMusicLibrary").catch(() => null);
	isLoadingLibrary.value = false;

	if (!result || result.error) {
		toast(t("settings.ytmusic.libraryFailed"), "close");
		return;
	}
	library.value = result;
}

function download(link: string) {
	sendAddToQueue(link);
}

function downloadAll(collections: YTMusicCollection[]) {
	sendAddToQueue(collections.map((collection) => collection.link).join(";"));
}
</script>

<template>
	<div class="space-y-5">
		<p class="secondary-text">{{ t("settings.ytmusic.description") }}</p>

		<template v-if="!loggedIn">
			<div class="input-group">
				<p class="mb-2">{{ t("settings.ytmusic.cookie") }}</p>
				<ol class="secondary-text mb-2 list-decimal pl-6 text-sm">
					<li>{{ t("settings.ytmusic.cookieSteps.step1") }}</li>
					<li>{{ t("settings.ytmusic.cookieSteps.step2") }}</li>
					<li>{{ t("settings.ytmusic.cookieSteps.step3") }}</li>
				</ol>
				<textarea
					v-model="cookie"
					rows="3"
					class="w-full font-mono text-sm"
					spellcheck="false"
					autocomplete="off"
				/>
			</div>
			<button
				class="btn btn-primary"
				:disabled="!cookie.trim() || isLoggingIn"
				@click="login"
			>
				{{ t("settings.ytmusic.login") }}
			</button>
		</template>

		<template v-else>
			<div class="flex items-center gap-4">
				<p>{{ t("settings.ytmusic.loggedIn", { name: accountName }) }}</p>
				<button class="btn btn-primary" @click="logout">
					{{ t("settings.login.logout") }}
				</button>
				<button
					class="btn btn-primary"
					:disabled="isLoadingLibrary"
					@click="loadLibrary"
				>
					{{
						isLoadingLibrary
							? t("globals.loading")
							: t("settings.ytmusic.loadLibrary")
					}}
				</button>
			</div>

			<template v-if="library">
				<section class="space-y-3">
					<div class="flex items-center gap-4">
						<h4 class="text-xl">{{ t("settings.ytmusic.quickPicks") }}</h4>
						<button
							class="btn btn-primary"
							:disabled="!library.quickPicks.length"
							@click="download(QUICK_PICKS_LINK)"
						>
							{{ t("globals.download_hint") }}
						</button>
					</div>
					<p v-if="!library.quickPicks.length" class="secondary-text">
						{{ t("settings.ytmusic.empty") }}
					</p>
					<ul v-else class="quick-picks">
						<li
							v-for="track in library.quickPicks"
							:key="track.videoId"
							class="flex items-center gap-3"
						>
							<img
								:src="track.thumbnail || PLACEHOLDER_COVER"
								class="h-10 w-10 rounded"
								aria-hidden="true"
							/>
							<div class="min-w-0">
								<p class="truncate">{{ track.title }}</p>
								<p class="secondary-text truncate text-sm">
									{{ track.artists.join(", ") }}
								</p>
							</div>
						</li>
					</ul>
				</section>

				<section class="flex items-center gap-4">
					<h4 class="text-xl">{{ t("settings.ytmusic.librarySongs") }}</h4>
					<button class="btn btn-primary" @click="download(LIBRARY_SONGS_LINK)">
						{{ t("globals.download_hint") }}
					</button>
				</section>

				<section
					v-for="group in [
						{ key: 'playlists', items: library.playlists },
						{ key: 'albums', items: library.albums },
					]"
					:key="group.key"
					class="space-y-3"
				>
					<div class="flex items-center gap-4">
						<h4 class="text-xl">{{ t(`settings.ytmusic.${group.key}`) }}</h4>
						<button
							class="btn btn-primary"
							:disabled="!group.items.length"
							@click="downloadAll(group.items)"
						>
							{{ t("settings.ytmusic.downloadAll") }}
						</button>
					</div>
					<p v-if="!group.items.length" class="secondary-text">
						{{ t("settings.ytmusic.empty") }}
					</p>
					<div v-else class="release-grid">
						<div v-for="item in group.items" :key="item.id" class="release">
							<CoverContainer
								:cover="item.thumbnail || PLACEHOLDER_COVER"
								:link="item.link"
								is-rounded
								@click.stop="download(item.link)"
							/>
							<p class="primary-text">{{ item.title }}</p>
							<p class="secondary-text">{{ item.subtitle }}</p>
						</div>
					</div>
				</section>
			</template>
		</template>
	</div>
</template>

<style scoped>
.quick-picks {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
	gap: 0.75rem 1.5rem;
}
</style>
