// this example serves as compliance example for calling within Webex Teams
// it works like this
// first it registers for 3 different webhooks:
// resource:call event:updated filter:status=disconnected
// resource:callMembership event:updated filter:status=joined
// resource:callMembership event:created filter:status=joined

// whenever we get a membership webhook, we add the personID/membership to an associative array
// if the array does not yet exist, we will build it
// thankfully the callMembership webhook has the callID in it, so
// I don't need to do any lookup.
// the associative array may look like this
// CallIDY28s8s[ membershipidY2993939 ];
// with each new membership joined event I will add the member to the array for this callID ( or create a new one )
// for 2 attendees it may look like this
// CallIDY28s8s[ membershipidY2993939 , membershipIdY2993940]

// Whenever I add a member to the array I will check if there is a policy violation. If there is I will hangup on
// that person, for example I could hangup up on membershipIdY2993940
// the array would then look like CallIDY28s8s[ membershipidY2993939 ]
// If the person rejoins I will see the same violation and can remove them again.
// Last if the call-disconnected-webhook fires I will remove the whole array for good.


// console color markup
const chalk = require('chalk')
// support http requests
const got = require('got')
// highland streams have some interesting capabilites that native streams don't support yet
const highland = require('highland')

// stream parse the webhooks data
const ts = require('JSONStream')
const ts1 = ts.parse('body')
// gets the webhook payload data section
// there are some issues with escaped quotes \" which is why this needs to be parsed in two steps instead of 1
// the first step does as a side effect remove the escaped quotes
const ts2 = ts.parse('data')


// interact with the teams API via a client object
const teams = require('ciscospark').init({
  credentials: {
    // for purposes of this program - to see any calls that happen in the org - this needs to be a token with the
    // scopes spark-admin:calls_read and spark-admin:call_memberships_read
    access_token: process.env.ADMIN_TOKEN
  }
})


// DLP POLICY - DLP POLICY - DLP POLICY
// This is our 1 line DLP policy - members in this array should not be in the same call - easy
const peopleWhoShouldNotTalk = ["raschiff@cisco.com", "krs3@schiffert.me"]
// DLP POLICY - DLP POLICY - DLP POLICY


var myApp = {
  // webhookinbox 3rd party server to receive our webhooks on who joined - that's convenient since we
  // don't need to use ngrok or a public server
  webhookInboxUrl: "",
  // list of webhook ids so we can remove them at the end
  webhooks: [],
  // id's of people who should not talk
  idsWhoShouldNotTalk: [],
  // violating memberships
  memberships2BRemoved: new Set(),

  forbiddenPeopleInCall: [],
  // this is the data structure we use to store all calls in the system
  // the people itself will be stored as Sets in the map
  // MapEntry -> SetOfCallMemberships
  // the set give us some handy shortcuts, for example if we want to check of the membership was already added
  calls: new Map(),
  // this map stores for each person their callMembershipId
  // even if the person calls in from several devices it will be under 1 callMembershipId
  // it would not work though if the person would join 2 different calls at the same time
  person2CallMembership: new Map(),

  init: function (emailsThatShouldNotTalk) {

    let kickoffPromise = this.deleteAllAccountWebhooks()
      .then(() => this.resolvePeople2Id(emailsThatShouldNotTalk))
      .then(() => this.createWebhookInbox())
      // the view URL is different from the API endpoint to insert events
      .then((webhookinbox) => {
        console.log("http://webhookinbox.com/view/" + webhookinbox.split("/").splice(-2)[0])
      })
      .then( () => this.refreshWebhookInboxRegularly() )
      .then(() => this.createWebhooks())
      .then(() => {
        return this.checkWhoCalledInAndHangup()
      })
    //.then( () => { return this.remindViolatorsInDirectMessage()})

    //this.resolvePeople2Id()
    //.then(console.log)
    //  console.log("webhookInbox at http://webhookinbox.com/view/" + inboxUrl.split("/").slice(-2)[0] + "/")
    //.then(this.createWebhookInbox())
    //.then(this.webhookInboxUrl)
    //.then(this.createWebhooks())
    //.catch(console.log)
    // authorizes the client and stores access in the teams object so we never have to explicitly authenticate
    // let kickoffPromise = teams.authorization.requestAccessTokenFromJwt({jwt: guestToken})
    // webhookinbox is a 3rd party website - the only reason I am using it so I don't have to run a server
    // locally, which some companies don't allow
    // instead I am creating a way to deposit a webhook on this site and then poll the site for who joined
    //    .then( () => { return this.createWebhookInbox() })
    // we convert email addresses to id's since it makes it easier to track who joined the meeting
    // the webhooks are keyed in personId's, not emails
    //  .then( () => { return this.resolvePeople2Id() })
    //.then( () => { return this.createSpace() })
    // when creating a room it doesn't give us back the room details
    // instead we need to query the room to get these details
    // .then( () => { return this.lookupSpaceDetails() })
    // now we can add the people to the space
    //.then( () => { return this.addMembersById2Space() })
    // now we register for each member a webhook which fires for when they are joined to the meeting
    // .then( () => { return this.createWebhooks() })
    // .then( () => { return this.postMessage("Welcome to the " + this.roomTitle + " huddle space") })
    // .then( () => { return this.callSpace() })
    // let's give people a couple of seconds to join
    // .then( () => {  return this.setupDelay(20) })
    // .then( () => { return this.checkWhoCalledInAndHangup() })
    // .then( () => { return this.remindSlackersInDirectMessage("Hey, can you join our call in the " +
    // this.roomTitle + " space") })
    // .then( () => {  return this.setupDelay(20) })
    // let's clean  up
    // .then( () => { return this.cleanupMeeting() })
    // .catch(console.log)
  },
  deleteAllAccountWebhooks: function () {

    // removes all webhooks registered by the account token
    return teams.webhooks.list({max: 100})
      .then(w => w.items.map(i => {
        return teams.webhooks.remove(i.id)
      }))
      .then(
        v => {
          return Promise.all(v)
        })
      .catch(console.log)
  },
  setupWebhookData: function () {

    // previously I had this as a promise based function
    // but this is something we can call sychronously

    // sets up the array for the 3 webhooks that we need to register later
    // it's just a helper to get the fields for the webhook setup right
    const wh1 = {
      name: "callJoined",
      resource: "callMemberships",
      event: "created",
      filter: "status=joined",
      targetUrl: this.webhookInboxUrl + 'in/',
      ownedBy: "org"
    }

    // technically speaking it is not necessary to setup the person filter here but it makes the code simpler
    // and more efficient hopefully. If we wanted to control dynamically which people must not talk we could
    // omit the person filter and rather check each incoming callMembership webhook
    if (!this.idsWhoShouldNotTalk || this.idsWhoShouldNotTalk.length == 0) {
      // we need the people ID's
      // return Promise.reject("need to call resolvePeople2Id before calling setupWebhookData")
      throw new Error('need to call resolvePeople2Id before calling setupWebhookData')
    }

    let webhookSet = this.idsWhoShouldNotTalk.map(i => {
      return Object.assign({}, wh1, {filter: `${wh1.filter}&personId=${i}`})
    })
    let wh2 = Object.assign({}, wh1, {event: "updated"})


    const whCallEnded = {
      name: "callEnded",
      resource: "calls",
      event: "updated",
      filter: "status=disconnected",
      targetUrl: this.webhookInboxUrl + 'in/',
      ownedBy: "org"
    }

    webhookSet.push(whCallEnded)

    // the spread operator splits the array into its constituents
    // otherwise we would have an array in an array
    webhookSet.push(...this.idsWhoShouldNotTalk.map(i => {
      return Object.assign({}, wh2, {filter: `${wh2.filter}&personId=${i}`})
    }))

    // callMemberships
    // return Promise.resolve(this.webhooks2Add = webhookSet)
    return webhookSet
  },
  createWebhooks: function () {

    // with the array of webhooks data to register we use it
    // to point the Teams API to the webhookinbox URL
    return Promise.all(
      this.setupWebhookData().map(i => {
        return teams.webhooks.create(i)
      }),
    ).then(w => this.webhooks = w).catch(console.log)
  },
  createWebhookInbox: function () {
    // the webhookinbox is just so we don't have to run a server
    // instead we are going to poll for events from it
    // frankly we could also poll from the events API but then it's not so awesome to watch
    // we are going to print out the link to the webhook inbox so you can watch the webhooks coming in
    return got('http://api.webhookinbox.com/create/', {method: 'POST'})
      .then(res => {
        return this.webhookInboxUrl = JSON.parse(res.body).base_url;
      })
  },
  refreshWebhookInboxRegularly: function () {

    // webhookinboxes get destroyd when they don't receive traffic within a fairly short TTL period
    // the way around this is to call /refresh/ in regular intervals
    let url = this.webhookInboxUrl + 'refresh/'

    setInterval( () => { got(url, { 'method':'POST' }).then( () => { console.log("inbox refreshed") }).catch(console.log) }, 60 * 1000 )

    return Promise.resolve()
  },
  resolvePeople2Id: function (disallowedPeopleArray) {
    // this returns a promise with an array of the peopleId's associated with the peopleWhoShouldNotTalk array,
    // which we setup as email addresses while internally mos API calls work with ID's
    return Promise.all(
      disallowedPeopleArray.map(i =>
        teams.people.list({email: i}).then(p => p.items[0].id)))
      .then(a => {
        return this.idsWhoShouldNotTalk = a
      })
  },
  createSpace: function () {
    return teams.rooms.create({title: this.roomTitle}).then(r => {
      return this.roomId = r.id
    })
  },
  lookupSpaceDetails: function () {
    // we need to do thjs to access the SIP URI of this space, which is not returned in the room creation
    return teams.rooms.get(this.roomId).then(r => {
      return this.roomSipUri = r.sipAddress
    })
  },
  addMembersByEmail2Space: function (people) {
    return Promise.all(
      people.map((m) => {
        return teams.memberships.create({roomId: this.roomId, personEmail: m})
      }))
  },
  addMembersById2Space: function () {
    return Promise.all(
      this.people2AddIds.map(id => {
        return teams.memberships.create({roomId: this.roomId, personId: id})
      })
    )
      .then(a => a.map(i => {
        this.people2Remind.unshift(i.personId)
      }))
      .then(() => {
        return this.people2Remind
      })
  },
  postMessage: function (msg) {
    return teams.messages.create({roomId: this.roomId, text: msg})
  },
  setupDelay: function (time) {
    let timeMs = time * 1000
    // some helper function that helps us wait before we poll who joined
    return new Promise(res => {
      setTimeout(() => {
        res(timeMs)
      }, timeMs)
    })
  },
  removeSpace: function () {
    // when the call is done we should remove the space
    // this will delete all memberships in the space as well
    // all ongoing calls will be deleted as well
    return teams.rooms.delete(this.roomId)
  },
  checkForPolicyViolation() {

    // now where we have modified our array with new callMemberships we should check if there is any violation
    // going on
    for (const c of this.calls.keys()) {
      this.forbiddenPeopleInCall = this.idsWhoShouldNotTalk.filter(x => calls.get(c).has(x))

      // in this call are 2 or more people who should not talk
      if (this.forbiddenPeopleInCall.length >= 2) {
        this.memberships2BRemoved.add(...this.forbiddenPeopleInCall.map(pid => person2CallMembership.get(pid)))

        return this.memberships2BRemoved
      }
    }

  },
  // this is the easier way to do it. the stream produces when a new item arrives
  checkWhoCalledInAndHangup: function () {

    let url = this.webhookInboxUrl + 'stream/'
    let attendees = []
    let self = this

    // when the stream is opened it comes back with the message '[opened]\n' which we don't want to parse
    highland(got.stream(url)).map(function (x) {
      return x.toString('utf-8').replace('[opened]\n', '')
    }).pipe(ts1).pipe(ts2).on('data', function handleDataRecord(data) {

      console.log('in data section')
      console.log(data)

      let callId = data.callId
      let personId = data.personId
      let callMembershipId = data.id

      // map between personId and callMembershipId
      self.person2CallMembership.set(personId, callMembershipId)


      // let's check if we have the callId already
      if (self.calls.has(callId)) {
        //get the set and add the person
        self.calls.get(callId).add(personId) // if the personId is already there, no harm is done - this is a set
      } else {
        self.calls.set(callId, new Set().add(personId)) // empty set of people
      }

      console.log(chalk.green('membershipID'), data.id)
      console.log(chalk.green('callId'), data.callId)
      console.log(chalk.green('personId'), data.personId)
      console.log(chalk.green('status'), data.status)

      if (self.checkForDLPDisallowed().size > 1) {
        self.hangupOnViolators().then((v) => {
          console.log('http' + v)
        }).catch(console.log)
      }
    }).on('end', function handleEnd() {
      console.log(chalk.green("stream closed"))
    })
    // filter doesn't work since the [opened] comes with the JSON object
    //  highland(got.stream(url)).filter(e => console.log(":-:" + e + ":-:")).pipe(process.stdout)

  },
  checkForDLPDisallowed: function () {

    console.log(1)

    // iterate over all calls
    for (const c of this.calls.keys()) {

      console.log(2)

      this.forbiddenPeopleInCall = this.idsWhoShouldNotTalk.filter(x => this.calls.get(c).has(x))

      console.log(this.forbiddenPeopleInCall)
      console.log(3)

      if (this.forbiddenPeopleInCall.length >= 2) {

        let tmpArr = this.forbiddenPeopleInCall.map(pid => this.person2CallMembership.get(pid))
        console.log(tmpArr)
        tmpArr.forEach(e => this.memberships2BRemoved.add(e))
        console.log(this.memberships2BRemoved)
      }
    }

    return this.memberships2BRemoved
  },
  hangupOnViolators: function () {

    console.log("START THIS MEMBERSHIPS 2B REMOVED")
    console.log(this.memberships2BRemoved)
    console.log("END")


    return Promise.all(
      // map doesn't work with sets
      // but map makes it easier to use Promise.all since forEach doesn't return anything
      // so we convert the set to an array
      // we used a set only to avoid duplicates
      [...this.memberships2BRemoved].map(i => {
        got('https://api.ciscospark.com/v1/call/commands/hangup',
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + process.env.ADMIN_TOKEN,
              'Content-type': 'application/json'
            },
            json: true,
            body: {
              "callMembershipId": i
            }
          })
          .then(() => {
            console.log('did hangup on ' + i + ' successfully')
            let tmp = this.memberships2BRemoved.filter(x => x != i)
            this.memberships2BRemoved = tmp

            console.log("tts " +  this.memberships2BRemoved)

            // return this.remindViolatorsInDirectMessage(i)
          })
          .catch(() => {
            console.log("could not hangup on membershipId " + i)
          })
      })
    )
  },
  remindViolatorsInDirectMessage: function (membershipId) {
    // reverse mapping to personId
    for (const [k, v] of this.person2CallMembership) {
      if (v == membershipId) {
        return teams.messages.create({toPersonId: k, text: "Your call has ended due to a policy violation"})
      }
    }
  },
  cleanupMeeting: function () {
    return twilio.calls(this.twilioCallSid).update({status: 'completed'})
      .then(() => {
        return teams.rooms.remove(this.roomId)
      })
      .then(() => {
        return Promise.all(
          this.webhooks.map(w => teams.webhooks.remove(w))
        )
      })
  }
}

myApp.init(peopleWhoShouldNotTalk)
