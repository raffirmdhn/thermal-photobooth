<?php

use Inertia\Testing\AssertableInertia as Assert;

test('home displays the thermal photobooth', function () {
    $this->get(route('home'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page->component('welcome'));
});
