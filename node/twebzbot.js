var tweetstream = require('tweetstream')
  , sys = require('sys')
  , url = require('url')
  , fs = require('fs')
  , path = require('path')
  , events = require('events')
  , request = require('request')
  , couchdb = require("couchdb")
  , tweasy = require("tweasy")
  , cc = require("couch-client")
  , OAuth= require("oauth").OAuth
  , jsond = require("../lib/jsond")
  , sha1 = require("../lib/sha1")
  ;

function log(e) {
  sys.puts(sys.inspect(e));
};

var config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')))
  , dburl = url.parse(config.db)
  , dbname = dburl.pathname.split('/')[1]
  , twebz = require('../lib/twebz').init(dbname)
  , client = couchdb.createClient(dburl.port, dburl.hostname, 
      twebz.app_user, config.passcode)
  , db = client.db(dbname)
  , config_db = client.db(twebz.config_db)
  ;

config_db.getDoc(twebz.twitter_keys_docid, function(er, doc) {
  var twitter_oauth;
  if (er) {
    log("error loading twitter_keys");
    log(er);
    log([twebz.app_user, config.passcode]);
    process.exit(1);
  } else {
    twitter_oauth = new OAuth(
      "http://twitter.com/oauth/request_token",
      "http://twitter.com/oauth/access_token", 
      doc.consumer_key,  doc.consumer_secret, 
      "1.0", null, "HMAC-SHA1");
  }
  
  function ok(er, doc, couch) {
    couch = couch || db; // default to db from closure
    if (er) {
      // log(['error', doc._id, er]);
      doc.twebz = doc.twebz || {};
      doc.twebz.state = "error";
      doc.twebz.error = er;
      couch.saveDoc(doc);
      return false
    } else {
      return true;
    }
  }

  function requestRecentTweets(doc) {
    twitterConnection(doc.twebz.couch_user, 
      doc.twebz.twitter_acct,
      function(tc) {
        // todo check to see what tweets we already have to avoid fetching what we don't need
        log("fetch recent tweets from "+doc.twebz.screen_name);
        tc.userTimeline({screen_name : doc.twebz.screen_name, count:100},
          function(er, tweets) {
            if (ok(er, doc)) {
              db.bulkDocs({
                docs : tweets.map(function(t) {
                  t._id = ""+t.id;
                  return t;
                })
              }, function(er, resp) {
                if (ok(er, doc)) {
                  doc.twebz.tweet_range = {
                    start : tweets[tweets.length -1].id,
                    end : tweets[0].id
                  }
                  doc.twebz.state = "fetched";
                  db.saveDoc(doc);
                }
              });
            }
          });
      });
  };

  function recentTweets(doc) {
    log("recentTweets state: "+doc.twebz.state);
    switch (doc.twebz.state) {
      case 'request':
        // doc.twebz.state = "skipped";
        // db.saveDoc(doc);
        requestRecentTweets(doc);
        break;
      case 'skipped':
        break;
      case 'fetched':
        break;
      default:
        log("recentTweets unknown state: "+doc.twebz.state);
        log(doc);
    }
  };

  function handleChange(change) {
    change.doc.twebz.seq = change.seq;
    if (change.doc.twebz.state == "error") {
      log("error state: "+change.doc._id);
      return;
    }
    switch (change.doc.twebz.type) {
      case 'link_account':
        linkAccount(change.doc);
        break;
      case 'tweet':
        handleTweet(change.doc);
        break;
      case 'user-recent':
        recentTweets(change.doc);
        break;
      default:
        log("unhandled change");
        log(change);
    }
  };

  function twitterConnection(couch_user, user_id, cb) {
    // load user creds
    var udb = client.db(twebz.user_db(couch_user));
    udb.view("twebz-private", "twitter-accts", {
      key : parseInt(user_id)
    }, function(er, resp) {
      if (resp.rows[0]) {
        var v = resp.rows[0].value
          , tc = tweasy.init(twitter_oauth, {
            access_token : v.oauth_access_token,
            access_token_secret : v.oauth_access_token_secret
          });
        cb(tc);
      } else {
        log("can't get twitter conection for "+couch_user+" and "+user_id);
      }
    });
  }

  function streamTweets(couch_user, user_id) {
    log("streamTweets for " + couch_user + " on twitter acct " + user_id);
    twitterConnection(couch_user, user_id, function(tc) {
      var stream = tc.userStream();
      stream.addListener("json", function(json) {
        if (json.friends) {
        } else {
          if (json.id) {
            json._id = ""+json.id; //avoid duplicates
          }
          db.saveDoc(json);
        }
      });
      stream.addListener("error", function(er) {
        log("error streaming for acct "+ user_id);
        log(er)
      });
      stream.addListener("end", function() {
        log(arguments)
        log("end streaming for acct "+ user_id);
      });
    });
  };

  function handleTweet(doc) {
    log("handleTweet state: "+doc.twebz.state);
    switch (doc.twebz.state) {
      case 'unsent':
        sendTweet(doc);
        break;
      case 'sent':
        break;
      case 'received':
        break;
      default:
        log("linkAccount unknown state: "+doc.twebz.state);
        log(doc);
    }
  }

  function validSignature(key, doc) {
    var clone = JSON.parse(JSON.stringify(doc));
    delete clone._rev;
    delete clone.twebz_signature;
    delete clone.twebz.seq;
    var string = jsond.stringify(clone)
      , hmac = sha1.b64_hmac_sha1(key, string)
      , token = doc.twebz_signature && doc.twebz_signature.token
      ;
    if (token && 
        hmac === token) {
      return true;
    } else {
      log("invalid signature! "+doc._id);
      log("got: "+hmac+" need: "+token);
      return false;
    }
  }

  function sendTweet(doc) {
    // first check the hmac
    var udb = client.db(twebz.user_db(doc.twebz.profile.name));
    udb.getDoc(twebz.secret_docid, function(er, secret) {
      if (ok(er, doc)) {
        var key = secret.token;
        if (validSignature(key, doc)) {
          twitterConnection(doc.twebz.profile.name, 
            doc.user.id, function(tc) {
              tc.updateStatus(doc.text, [{twebz : {id : doc._id}}], 
                function(er, resp) {
                  if (ok(er, doc)) {
                    log("sent tweet for "+doc.user.screen_name+": "+doc.text);
                    doc.twebz.state = 'sent';
                    doc.twebz.twitter_id = resp.id;
                    db.saveDoc(doc);
                  }
              });
            });
        }
      }
    });
  }

  function getProfileInfo(doc) {
    if (doc.twebz.couch_user && doc.twebz.twitter_user && 
      doc.twebz.twitter_user.user_id) {
      var profile_id = twebz.profile_docid(doc.twebz.twitter_user.user_id);
      db.getDoc(profile_id, function(er, profile_doc) {
        if (er && er.error == "not_found") {
          profile_doc = {_id : profile_id};
        }
        twitterConnection(doc.twebz.couch_user, 
          doc.twebz.twitter_user.user_id, function(tc) {
            tc.userProfile({
              user_id : doc.twebz.twitter_user.user_id
            }, function(er, profile) {
              delete profile.status;
              profile._id = profile_doc._id;
              profile._rev = profile_doc._rev;
              db.saveDoc(profile, function(er, resp) {
                if (ok(er, doc)) {
                  doc.twebz.state = "complete";
                  db.saveDoc(doc);
                }
              });
            });
          });
      });
    }
  }

  function linkAccount(doc) {
    log("linkAccount state: "+doc.twebz.state);
    switch (doc.twebz.state) {
      case 'request':
        requestToken(doc);
        break;
      case 'launched':
        requestTokenVerified(doc);
        break;
      case 'connected':
        getProfileInfo(doc);
        break;
      case 'complete':
        break;
      default:
        log("linkAccount unknown state: "+doc.twebz.state);
        log(doc);
    }
  }

  function requestToken(doc) {
    var udb = client.db(twebz.user_db(doc.twebz.couch_user));
    udb.view("twebz-private","oauth-tokens",{
      key : ["request_token", "new"]
    }, function(er, resp) {
      if (ok(er, doc)) {
        if (resp.rows.length > 0) {
          // we already have a valid request token, do nothing
          log("no need to requestToken");
        } else {
          log("requestToken!");
          twitter_oauth.getOAuthRequestToken(function(er, 
                oauth_token, oauth_token_secret, params) {
            if (ok(er, doc)) {
              // we have a request token, save it to the user-db
              udb.saveDoc({
                type : "request_token",
                state : "new",
                created_at : new Date(),
                oauth_token_secret : oauth_token_secret,
                oauth_token : oauth_token,
                params : params
              }, function(er, resp) {
                if (ok(er, doc)) {
                  doc.twebz.state = "launched";
                  db.saveDoc(doc);
                }
              });
            }
          });
        }
      }
    });
  };

  function accessToken(udb, doc, rdoc) {
    twitter_oauth.getOAuthAccessToken(doc.oauth_token, doc.oauth_token_secret,
      doc.pin, function(er, oauth_access_token, oauth_access_token_secret, extra) {
        if (ok(er, doc)) {
          doc.state = "has_access";
          doc.oauth_access_token = oauth_access_token;
          doc.oauth_access_token_secret = oauth_access_token_secret;
          doc.access_params = extra;
        }
        udb.saveDoc(doc, function(er) {
          if (ok(er, doc)) {
            rdoc.twebz.twitter_user = extra;
            rdoc.twebz.state = "connected";
          }
          db.saveDoc(rdoc);
        });
      });
  }

  function requestTokenVerified(doc) {
    // hang on udb changes waiting for the request_token response to be saved
    var udb = client.db(twebz.user_db(doc.twebz.couch_user))
      , stream = udb.changesStream({
          include_docs : true,
          since : 0
        });
    stream.addListener("data", function(change) {
      var cdoc = change.doc;
      if (cdoc.type == "request_token" && cdoc.state == "has_pin" && cdoc.pin) {
        log("got a PIN we can use "+cdoc.pin);
        // disconnect from changes
        accessToken(udb, cdoc, doc)
      }
    });
  }

  // listen for _changes on twebz db
  function getSince(cb) {
    db.view("twebz","seq", {}, function(er, resp) {
      if (resp.rows.length > 0) {
        cb(resp.rows[0].value.max);
      } else {
        cb(0);
      }
    });
  };

  function workFromChanges() {
    getSince(function(since) {
      var stream = db.changesStream({
        filter : "twebz/twebz",
        include_docs : true,
        since : since
      });
      stream.addListener("data", handleChange);
    });
  };

  function startUserStreams() {
    db.view("twebz","account-links", {
      startkey : ["complete"],
      endkey : ["complete",{}]
    }, function(er, resp) {
      if (!er) {
        resp.rows.forEach(function(row) {
          if (row.value.twitter_user) {
            streamTweets(row.value.couch_user, row.value.twitter_user.user_id);            
          }
        });
      }
    });
  }

  workFromChanges();
  startUserStreams();
});
